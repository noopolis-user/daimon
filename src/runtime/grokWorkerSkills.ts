import { createHash } from "node:crypto";

import { canonicalJson } from "../contracts/canonicalJson.js";
import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";

const LAYOUT = GROK_ENGINE_BROKER.worker.home.skillsDirectory;

/**
 * One file of a declared agent skill, relative to the skill's own directory.
 * `SKILL.md` is required; supporting files (references, scripts) are optional.
 */
export type AgentSkillFile = Readonly<{ path: string; content: string }>;
/** One declared agent skill: its directory name and every file under it. */
export type AgentSkill = Readonly<{ name: string; files: readonly AgentSkillFile[] }>;

/**
 * The engine-neutral skills input. It is the compiled workspace tree every
 * engine is given — Spawnfile lowers declared skills (and Moltnet installs its
 * own) into `<workspace>/.agents/skills/<name>/SKILL.md`, which Codex reads in
 * place. A brokered Grok worker cannot read it there: its workspace stays
 * untrusted, so root provisioning renders the same skills into
 * `$GROK_HOME/skills` instead.
 */
export const AGENT_SKILLS_WORKSPACE_DIRECTORY = ".agents/skills" as const;
export const GROK_WORKER_SKILLS_VERSION = LAYOUT.digestVersion;
export const AGENT_SKILLS_BOUNDS = Object.freeze({ skills: 64, filesPerSkill: 64, fileBytes: 262_144, totalBytes: 4_194_304, depth: 8 });

const COMPONENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const invalid = (detail: string): TypeError => new TypeError(`invalid agent skills: ${detail}`);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const byteLength = (content: string): number => Buffer.byteLength(content, "utf8");

/**
 * Strict, canonicalizing parser: names and path components are plain
 * identifiers (no `.`/`..`, no hidden entries, no separators other than `/`),
 * every skill carries `SKILL.md`, nothing collides, and the sizes are bounded.
 * Output is sorted by name and path so equal sets digest equally.
 */
export function parseAgentSkills(value: unknown): readonly AgentSkill[] {
  if (!Array.isArray(value) || value.length > AGENT_SKILLS_BOUNDS.skills) throw invalid("expected a bounded array");
  let total = 0;
  const names = new Set<string>();
  const skills = value.map((entry: unknown): AgentSkill => {
    if (!plain(entry) || !exact(entry, ["name", "files"]) || typeof entry.name !== "string" || !COMPONENT.test(entry.name)) throw invalid("skill name");
    if (names.has(entry.name)) throw invalid(`duplicate skill ${entry.name}`);
    names.add(entry.name);
    if (!Array.isArray(entry.files) || entry.files.length === 0 || entry.files.length > AGENT_SKILLS_BOUNDS.filesPerSkill) throw invalid(`files of ${entry.name}`);
    const paths = new Set<string>();
    const files = entry.files.map((file: unknown): AgentSkillFile => {
      if (!plain(file) || !exact(file, ["path", "content"]) || typeof file.path !== "string" || typeof file.content !== "string") throw invalid(`file of ${entry.name}`);
      const parts = file.path.split("/");
      if (parts.length > AGENT_SKILLS_BOUNDS.depth || parts.some((part) => !COMPONENT.test(part))) throw invalid(`path ${JSON.stringify(file.path)}`);
      const bytes = byteLength(file.content);
      if (bytes > AGENT_SKILLS_BOUNDS.fileBytes) throw invalid(`size of ${entry.name}/${file.path}`);
      total += bytes;
      if (paths.has(file.path)) throw invalid(`duplicate path ${entry.name}/${file.path}`);
      paths.add(file.path);
      try { canonicalJson(file.content); } catch { throw invalid(`content of ${entry.name}/${file.path} is not Unicode text`); }
      return Object.freeze({ path: file.path, content: file.content });
    });
    // A file may not also be the directory of another file.
    for (const candidate of paths) if ([...paths].some((other) => other.startsWith(`${candidate}/`))) throw invalid(`path collision ${entry.name}/${candidate}`);
    if (!paths.has("SKILL.md")) throw invalid(`${entry.name} has no SKILL.md`);
    return Object.freeze({ name: entry.name, files: Object.freeze(files.sort((a, b) => compare(a.path, b.path))) });
  });
  if (total > AGENT_SKILLS_BOUNDS.totalBytes) throw invalid("total size");
  return Object.freeze(skills.sort((a, b) => compare(a.name, b.name)));
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/**
 * sha256 over the canonical description of the rendered tree: every skill's
 * name and, per file, its path, byte length and content digest. The broker
 * attests `$GROK_HOME/skills` against it before every turn, and the Grok broker
 * projection carries it, so the slot preflight receipt and every recomputed
 * projection bind the exact skills a subject was given.
 */
export function grokWorkerSkillsSha256(skills: readonly AgentSkill[]): string {
  const parsed = parseAgentSkills(skills);
  const description = { version: GROK_WORKER_SKILLS_VERSION, skills: parsed.map((skill) => ({
    name: skill.name,
    files: skill.files.map((file) => ({ path: file.path, bytes: byteLength(file.content), sha256: createHash("sha256").update(file.content, "utf8").digest("hex") }))
  })) };
  return createHash("sha256").update(canonicalJson(description)).digest("hex");
}

/** One entry root provisioning creates, relative to `$GROK_HOME`, owned `uid:gid`. */
export type GrokWorkerSkillsEntry = Readonly<{ path: string; kind: "directory" | "file"; uid: number; gid: number; mode: number; content?: string }>;

/**
 * Every directory and file root provisioning writes for these skills, parents
 * before children: `skills/` itself, each `skills/<name>/`, any intermediate
 * directory, and each file. Directories are `root:root 0555` and files
 * `root:root 0444` (single link), so a worker-uid process can read them but
 * neither change nor replace them; `$GROK_HOME` is root-owned and sticky, so the
 * worker cannot rename `skills/` away either. No skills renders nothing: the
 * directory must then be absent, exactly as before this layout existed.
 */
export function renderGrokWorkerSkillsTree(skills: readonly AgentSkill[]): readonly GrokWorkerSkillsEntry[] {
  const parsed = parseAgentSkills(skills);
  if (parsed.length === 0) return Object.freeze([]);
  const directory = (relative: string): GrokWorkerSkillsEntry => Object.freeze({ path: relative, kind: "directory", uid: LAYOUT.uid, gid: LAYOUT.gid, mode: LAYOUT.directoryMode });
  const entries: GrokWorkerSkillsEntry[] = [directory(LAYOUT.relativePath)];
  const seen = new Set<string>([LAYOUT.relativePath]);
  for (const skill of parsed) {
    for (const file of skill.files) {
      const parts = [LAYOUT.relativePath, skill.name, ...file.path.split("/")];
      for (let depth = 2; depth < parts.length; depth += 1) {
        const relative = parts.slice(0, depth).join("/");
        if (!seen.has(relative)) { seen.add(relative); entries.push(directory(relative)); }
      }
      entries.push(Object.freeze({ path: parts.join("/"), kind: "file", uid: LAYOUT.uid, gid: LAYOUT.gid, mode: LAYOUT.fileMode, content: file.content }));
    }
  }
  return Object.freeze(entries);
}
