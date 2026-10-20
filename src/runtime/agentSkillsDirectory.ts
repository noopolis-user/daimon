import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import { AGENT_SKILLS_BOUNDS, parseAgentSkills, type AgentSkill, type AgentSkillFile } from "./grokWorkerSkills.js";

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
  assertEntry(top, "directory", policy);
  const names = await boundedEntries(root, AGENT_SKILLS_BOUNDS.skills);
  const skills: { name: string; files: AgentSkillFile[] }[] = [];
  let budget = AGENT_SKILLS_BOUNDS.totalBytes;
  for (const name of names) {
    const directory = path.join(root, name);
    assertEntry(await lstat(directory), "directory", policy);
    const files: AgentSkillFile[] = [];
    const walk = async (relative: string, depth: number): Promise<void> => {
      for (const child of await boundedEntries(path.join(directory, relative), AGENT_SKILLS_BOUNDS.filesPerSkill)) {
        const childRelative = relative === "" ? child : `${relative}/${child}`;
        const absolute = path.join(directory, childRelative);
        const entry = await lstat(absolute);
        if (entry.isDirectory()) {
          if (depth + 1 >= AGENT_SKILLS_BOUNDS.depth) throw invalid("too deep");
          assertEntry(entry, "directory", policy);
          await walk(childRelative, depth + 1);
          continue;
        }
        assertEntry(entry, "file", policy);
        if (files.length >= AGENT_SKILLS_BOUNDS.filesPerSkill) throw invalid("too many files");
        const content = await readPinnedFile(absolute, entry, Math.min(AGENT_SKILLS_BOUNDS.fileBytes, budget));
        budget -= Buffer.byteLength(content, "utf8");
        files.push({ path: childRelative, content });
      }
    };
    await walk("", 0);
    skills.push({ name, files });
  }
  return parseAgentSkills(skills);
}

function assertEntry(entry: Stats, kind: "directory" | "file", policy: AgentSkillsTreePolicy): void {
  if (entry.isSymbolicLink() || (kind === "directory" ? !entry.isDirectory() : !entry.isFile())) throw invalid(`expected a plain ${kind}`);
  if (policy.ownerUid !== undefined && entry.uid !== policy.ownerUid) throw invalid("unexpected owner");
  if (policy.readOnly === true && ((Number(entry.mode) & 0o7222) !== 0 || (kind === "file" && entry.nlink !== 1))) throw invalid("writable or linked entry");
}

async function boundedEntries(directory: string, limit: number): Promise<string[]> {
  const entries = await readdir(directory);
  if (entries.length > limit) throw invalid("too many entries");
  return entries.sort();
}

/** Opens without following links and requires the inode `lstat` saw, so a swap between the two cannot change the bytes read. */
async function readPinnedFile(file: string, seen: Stats, limit: number): Promise<string> {
  if (seen.size > limit) throw invalid("file too large");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino || opened.uid !== seen.uid || opened.mode !== seen.mode || opened.nlink !== seen.nlink || opened.size > limit) throw invalid("file changed while read");
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw invalid("file too large");
    try { return decoder.decode(bytes); } catch { throw invalid("file is not UTF-8"); }
  } finally { await handle.close().catch(() => undefined); }
}
