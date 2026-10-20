import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
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
 * Attests the worker home layout, that `config.toml` is exactly the
 * renderer's bytes for the declared model policy (`configSha256`), and that
 * `skills/` is exactly the declared skills (`skillsSha256`, absent for none).
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
    return variant;
  } catch { throw unavailable(); } finally { await handle?.close().catch(() => undefined); }
}

const unavailable = (): Error => new Error("Grok worker isolation attestation unavailable");
