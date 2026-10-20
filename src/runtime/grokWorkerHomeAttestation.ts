import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import type { GrokWorkerConfigVariant } from "../contracts/grokBrokerTaskClock.js";
import { readAgentSkillsDirectory } from "./agentSkillsDirectory.js";
import { GROK_WORKER_SKILLS_LAYOUT, grokWorkerSkillsSha256 } from "./grokWorkerSkills.js";

export type GrokWorkerConfigPins = string | Readonly<Record<GrokWorkerConfigVariant, string>>;

type Entry = Pick<Stats, "uid" | "mode" | "nlink"> & Partial<Pick<Stats, "dev" | "ino">> & Readonly<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
const HOME = GROK_ENGINE_BROKER.worker.home;

/**
 * The worker must not be able to change what Grok reads before its next turn.
 *
 * Grok writes its own state (sessions, hooks, locks, docs) into `$GROK_HOME`,
 * so the directory is worker-group writable — but root-owned and sticky, so a
 * worker can neither rename nor unlink a root-owned file in it. Every file
 * that decides a turn's behaviour is root-owned with no write bit: `config.toml`
 * (model, effort, MCP, bundled-skill toggles), `sandbox.toml`, `trusted_folders.toml` (trust
 * would re-enable cwd `AGENTS.md` and project skills), and the managed and
 * requirements layers that can override user config. A missing file fails
 * too: the worker could create it.
 *
 * Pure so every refusal is testable without root.
 */
export function assertGrokWorkerHomeEntries(entries: Readonly<Record<string, Entry | undefined>>, rootUid: number = HOME.directory.uid): void {
  const directory = (entry: Entry | undefined): boolean =>
    entry !== undefined && entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === rootUid
    && (Number(entry.mode) & 0o002) === 0 && ((Number(entry.mode) & 0o020) === 0 || (Number(entry.mode) & 0o1000) !== 0);
  if (!directory(entries["."]) || !directory(entries[HOME.sessionsDirectory.relativePath])) throw unavailable();
  for (const name of HOME.readOnlyFiles.names) {
    const entry = entries[name];
    if (entry === undefined || !entry.isFile() || entry.isSymbolicLink() || entry.uid !== rootUid || entry.nlink !== 1 || (Number(entry.mode) & 0o7222) !== 0) throw unavailable();
  }
}

/** The worker's `config.toml` must be exactly the renderer's bytes for the declared policy. */
export function assertGrokWorkerConfigBytes(bytes: Uint8Array, pins: GrokWorkerConfigPins): GrokWorkerConfigVariant {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const variants = typeof pins === "string" ? { unclocked: pins } : pins;
  for (const variant of ["unclocked", "clocked"] as const) {
    const pin = (variants as Partial<Record<GrokWorkerConfigVariant, string>>)[variant];
    if (pin !== undefined && /^[0-9a-f]{64}$/u.test(pin) && digest === pin) return variant;
  }
  throw unavailable();
}

/**
 * The worker's `$GROK_HOME/skills` must be exactly the declared skills.
 *
 * Grok loads that directory as user-scoped skills even in an untrusted
 * workspace, and `$GROK_HOME` is worker-group writable, so a worker could plant
 * a skill there for its next turn. With no `skillsSha256` declared the
 * directory must be absent (or an empty root-owned read-only directory); with
 * one declared, every entry must be root-owned with no write bit and the tree
 * must hash to it. A worker-created or worker-modified tree fails either way.
 */
export async function verifyGrokWorkerSkills(grokHome: string, skillsSha256: string | undefined, rootUid: number = HOME.directory.uid): Promise<void> {
  if (skillsSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(skillsSha256)) throw unavailable();
  let skills;
  try { skills = await readAgentSkillsDirectory(path.join(grokHome, GROK_WORKER_SKILLS_LAYOUT.relativePath), { ownerUid: rootUid, readOnly: true }); } catch { throw unavailable(); }
  if (grokWorkerSkillsSha256(skills ?? []) !== (skillsSha256 ?? grokWorkerSkillsSha256([]))) throw unavailable();
}

/**
 * Every other skill root Grok discovers at user scope, which the worker could
 * plant into: under `$GROK_HOME` (root-owned but worker-group writable and
 * sticky, so the worker can create new entries) and under the worker's own
 * `$HOME` (the launcher exports `HOME=<home>` and `GROK_HOME=<home>/.grok`;
 * `<home>` is worker-owned). Only `$GROK_HOME/skills` may carry skills, and only
 * the declared ones; each root here must be absent, or an empty root-owned
 * directory with no write bit.
 *
 * Set from `grok inspect` with scratch `HOME`/`GROK_HOME` and no network
 * (1.0.60: every root below listed a planted skill or command; `.codex/skills`,
 * `.ai/skills`, `$HOME/.config/*` and `$HOME/.agents/plugins` did not) and from
 * the pinned 1.0.34 binary's own skills table (`~/.grok/{skills,commands}`,
 * `~/.claude/{skills,commands}`, `~/.cursor/skills`, `.agents/{skills,commands}`
 * at each tier). `bundled/skills` is the bundled-skill cache: never created on
 * 1.0.34 (P0 container evidence), but a skill planted there loads with a name
 * `[skills] disabled` does not cover. `plugins/` folders load their skills and
 * commands as trusted user plugins.
 */
export const GROK_WORKER_FOREIGN_SKILL_ROOTS = Object.freeze({
  grokHome: Object.freeze(["commands", "bundled/skills", "plugins"] as const),
  home: Object.freeze([".agents/skills", ".agents/commands", ".claude/skills", ".claude/commands", ".cursor/skills", ".cursor/commands"] as const)
});

/**
 * Refuses a foreign skill root (`GROK_WORKER_FOREIGN_SKILL_ROOTS`) that exists
 * and is not an empty root-owned read-only directory. A deployment that never
 * creates them passes unchanged. `grokHome` must be `<home>/.grok`, the
 * launcher's layout, so `<home>` is its parent.
 */
export async function verifyGrokWorkerForeignSkillRoots(grokHome: string, rootUid: number = HOME.directory.uid): Promise<void> {
  if (path.basename(grokHome) !== ".grok") throw unavailable();
  const home = path.dirname(grokHome);
  const roots = [...GROK_WORKER_FOREIGN_SKILL_ROOTS.grokHome.map((root) => path.join(grokHome, root)), ...GROK_WORKER_FOREIGN_SKILL_ROOTS.home.map((root) => path.join(home, root))];
  for (const root of roots) {
    let entry: Stats;
    try { entry = await lstat(root); } catch (error) {
      // Absent, or a parent that is not a directory: Grok finds nothing there either.
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw unavailable();
    }
    if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== rootUid || (Number(entry.mode) & 0o7222) !== 0) throw unavailable();
    let children: string[];
    try { children = await readdir(root); } catch { throw unavailable(); }
    if (children.length !== 0) throw unavailable();
  }
}

/**
 * Attests the worker home layout, that `config.toml` is exactly the
 * renderer's bytes for the declared model policy (`configSha256`), that
 * `skills/` is exactly the declared skills (`skillsSha256`, absent for none),
 * and that no other user skill root holds anything
 * (`verifyGrokWorkerForeignSkillRoots`).
 */
export async function verifyGrokWorkerHome(grokHome: string, configSha256: GrokWorkerConfigPins, rootUid: number = HOME.directory.uid, skillsSha256?: string): Promise<GrokWorkerConfigVariant> {
  const entries: Record<string, Entry | undefined> = {};
  for (const name of [".", HOME.sessionsDirectory.relativePath, ...HOME.readOnlyFiles.names]) {
    try { entries[name] = await lstat(path.join(grokHome, name)); } catch { entries[name] = undefined; }
  }
  assertGrokWorkerHomeEntries(entries, rootUid);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path.join(grokHome, "config.toml"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    const before = entries["config.toml"]!;
    // Same inode as the lstat above, as in `secureOpen`: a rename between the two cannot swap in other bytes.
    if (!opened.isFile() || opened.size > 65_536 || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== before.uid || opened.mode !== before.mode || opened.nlink !== 1) throw unavailable();
    const variant = assertGrokWorkerConfigBytes(await handle.readFile(), configSha256);
    await verifyGrokWorkerSkills(grokHome, skillsSha256, rootUid);
    await verifyGrokWorkerForeignSkillRoots(grokHome, rootUid);
    return variant;
  } catch { throw unavailable(); } finally { await handle?.close().catch(() => undefined); }
}

const unavailable = (): Error => new Error("Grok worker isolation attestation unavailable");
