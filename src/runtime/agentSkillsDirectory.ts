import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import { AGENT_SKILLS_BOUNDS, parseAgentSkills, type AgentSkill, type AgentSkillFile } from "../engines/grok/broker/grokWorkerSkills.js";

/**
 * What every entry of a skills tree must satisfy beyond being a plain,
 * non-symlink directory or regular file. Attesting a root-provisioned
 * `$GROK_HOME/skills` sets both; reading a compiled workspace leaves them unset.
 */
export type AgentSkillsTreePolicy = Readonly<{ ownerUid?: number; readOnly?: boolean }>;

const invalid = (detail: string): TypeError => new TypeError(`invalid agent skills directory: ${detail}`);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reads a skills tree — `<root>/<name>/SKILL.md` plus any supporting files —
 * into the engine-neutral {@link AgentSkill} input, or `undefined` when `root`
 * does not exist.
 *
 * It is the same reader for both ends of the Grok skills path: provisioning
 * reads the compiled workspace's `.agents/skills` (the tree Codex reads in
 * place), and the broker re-reads the rendered `$GROK_HOME/skills` before every
 * turn under a root-owned, read-only policy. Symlinks, special files, hard
 * links (read-only policy), non-UTF-8 content and anything past the
 * {@link AGENT_SKILLS_BOUNDS} are refused rather than skipped, because a
 * skipped entry would make the attested digest describe less than Grok loads.
 */
export async function readAgentSkillsDirectory(root: string, policy: AgentSkillsTreePolicy = {}): Promise<readonly AgentSkill[] | undefined> {
  let top: Stats;
  try { top = await lstat(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalid("unreadable root");
  }
  assertEntry(top, "directory", policy, ".");
  const names = await boundedEntries(root, AGENT_SKILLS_BOUNDS.skills);
  const skills: { name: string; files: AgentSkillFile[] }[] = [];
  let budget = AGENT_SKILLS_BOUNDS.totalBytes;
  for (const name of names) {
    const directory = path.join(root, name);
    assertEntry(await lstat(directory), "directory", policy, name);
    const files: AgentSkillFile[] = [];
    const walk = async (relative: string, depth: number): Promise<void> => {
      for (const child of await boundedEntries(path.join(directory, relative), AGENT_SKILLS_BOUNDS.filesPerSkill)) {
        const childRelative = relative === "" ? child : `${relative}/${child}`;
        const absolute = path.join(directory, childRelative);
        const where = `${name}/${childRelative}`;
        const entry = await lstat(absolute);
        if (entry.isDirectory()) {
          if (depth + 1 >= AGENT_SKILLS_BOUNDS.depth) throw invalid(`too deep at ${JSON.stringify(where)}`);
          assertEntry(entry, "directory", policy, where);
          await walk(childRelative, depth + 1);
          continue;
        }
        assertEntry(entry, "file", policy, where);
        if (files.length >= AGENT_SKILLS_BOUNDS.filesPerSkill) throw invalid(`too many files in ${JSON.stringify(name)}`);
        const content = await readPinnedFile(absolute, where, entry, Math.min(AGENT_SKILLS_BOUNDS.fileBytes, budget));
        budget -= Buffer.byteLength(content, "utf8");
        files.push({ path: childRelative, content });
      }
    };
    await walk("", 0);
    skills.push({ name, files });
  }
  return parseAgentSkills(skills);
}

/** `where` is the entry's path relative to the skills root, named in every refusal. */
function assertEntry(entry: Stats, kind: "directory" | "file", policy: AgentSkillsTreePolicy, where: string): void {
  if (entry.isSymbolicLink() || (kind === "directory" ? !entry.isDirectory() : !entry.isFile())) throw invalid(`expected a plain ${kind} at ${JSON.stringify(where)}`);
  if (policy.ownerUid !== undefined && entry.uid !== policy.ownerUid) throw invalid(`unexpected owner of ${JSON.stringify(where)}`);
  if (policy.readOnly === true && ((Number(entry.mode) & 0o7222) !== 0 || (kind === "file" && entry.nlink !== 1))) throw invalid(`writable or linked entry ${JSON.stringify(where)}`);
}

async function boundedEntries(directory: string, limit: number): Promise<string[]> {
  const entries = await readdir(directory);
  if (entries.length > limit) throw invalid(`too many entries in ${JSON.stringify(path.basename(directory))}`);
  return entries.sort();
}

/** Opens without following links and requires the inode `lstat` saw, so a swap between the two cannot change the bytes read. */
async function readPinnedFile(file: string, where: string, seen: Stats, limit: number): Promise<string> {
  if (seen.size > limit) throw invalid(`file too large ${JSON.stringify(where)}`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino || opened.uid !== seen.uid || opened.mode !== seen.mode || opened.nlink !== seen.nlink || opened.size > limit) throw invalid(`file changed while read ${JSON.stringify(where)}`);
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw invalid(`file too large ${JSON.stringify(where)}`);
    try { return decoder.decode(bytes); } catch { throw invalid(`file is not UTF-8 ${JSON.stringify(where)}`); }
  } finally { await handle.close().catch(() => undefined); }
}
