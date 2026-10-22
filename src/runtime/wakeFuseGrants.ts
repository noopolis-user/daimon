import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { TURN_USAGE_MAX_IDENTIFIER_CHARS } from "./turnUsageLedger.js";

export const WAKE_FUSE_GRANTS_VERSION = "noopolis.daimon.wake-fuse-grants.v1" as const;
export const WAKE_FUSE_GRANTS_FILE = "grants.json" as const;
const MAX_GRANTS_BYTES = 64 * 1024;
const MAX_GRANT_AGENTS = 256;

export type OrganizationGrant = Readonly<{ extraWakes: number; extraTokens: number }>;
export type AgentGrant = Readonly<{ extraExecutions: number; extraTokens: number }>;
export type WakeFuseGrant = Readonly<{ organization: OrganizationGrant; agents: ReadonlyMap<string, AgentGrant> }>;
type ParsedGrants = Readonly<{ epoch: string; grant: WakeFuseGrant }>;

export const NO_GRANT: WakeFuseGrant = Object.freeze({ organization: Object.freeze({ extraWakes: 0, extraTokens: 0 }), agents: new Map() });

/**
 * Strict parser for the operator's `grants.json`. Throws on anything it does
 * not fully understand: an unknown key is more likely a typo that would grant
 * nothing than a field to ignore, and the caller turns a throw into NO grant.
 */
export function parseWakeFuseGrants(value: unknown): ParsedGrants {
  const root = record(value, "grants");
  allowOnly(root, ["version", "epoch", "organization", "agents"], "grants");
  if (root.version !== WAKE_FUSE_GRANTS_VERSION) throw new TypeError(`grants.version must be ${WAKE_FUSE_GRANTS_VERSION}`);
  if (typeof root.epoch !== "string" || root.epoch.trim() === "" || root.epoch !== root.epoch.trim()) throw new TypeError("grants.epoch must be a non-blank string");
  const organization = root.organization === undefined ? {} : record(root.organization, "grants.organization");
  allowOnly(organization, ["extra_wakes", "extra_tokens"], "grants.organization");
  const agents = new Map<string, AgentGrant>();
  const agentRows = root.agents === undefined ? {} : record(root.agents, "grants.agents");
  if (Object.keys(agentRows).length > MAX_GRANT_AGENTS) throw new TypeError("grants.agents has too many entries");
  for (const [agentId, row] of Object.entries(agentRows)) {
    if (agentId === "" || [...agentId].length > TURN_USAGE_MAX_IDENTIFIER_CHARS) throw new TypeError("grants.agents has an invalid agent id");
    const agent = record(row, `grants.agents.${agentId}`);
    allowOnly(agent, ["extra_executions", "extra_tokens"], `grants.agents.${agentId}`);
    agents.set(agentId, { extraExecutions: extra(agent.extra_executions, "extra_executions"), extraTokens: extra(agent.extra_tokens, "extra_tokens") });
  }
  return { epoch: root.epoch, grant: { organization: { extraWakes: extra(organization.extra_wakes, "extra_wakes"), extraTokens: extra(organization.extra_tokens, "extra_tokens") }, agents } };
}

/**
 * A grant names the window it is for, so it expires by itself. The operator
 * may write the full epoch, or — for the date-derived epoch, whose prefix is an
 * organization hash nobody types — just its `YYYY-MM-DD` day in the epoch zone.
 */
export function grantAppliesToEpoch(grantEpoch: string, epoch: string): boolean {
  if (grantEpoch === epoch) return true;
  return /^\d{4}-\d{2}-\d{2}$/u.test(grantEpoch) && new RegExp(`^organization-[a-f0-9]{64}-${grantEpoch}$`, "u").test(epoch);
}

/** Declared limit plus grant. A grant is non-negative by validation, so it can only raise. */
export function raised(declared: number, extraAllowance: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, declared + Math.max(0, extraAllowance));
}

/**
 * Re-reads `<fuse directory>/grants.json` whenever its stat identity changes.
 * Never throws: a missing file is no grant, and an unreadable or malformed one
 * is no grant plus ONE warning per distinct file state (fail closed — the
 * declared limits stand).
 */
export class WakeFuseGrantReader {
  private cached: Readonly<{ signature: string; parsed: ParsedGrants | undefined }> | undefined;
  private warned: string | undefined;

  constructor(private readonly directory: string) {}

  path(): string { return path.join(this.directory, WAKE_FUSE_GRANTS_FILE); }

  async read(epoch: string): Promise<WakeFuseGrant> {
    const parsed = await this.load();
    return parsed !== undefined && grantAppliesToEpoch(parsed.epoch, epoch) ? parsed.grant : NO_GRANT;
  }

  /** Cheap identity of the file's current state, for change detection. */
  async signature(): Promise<string> {
    try {
      const handle = await open(this.path(), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return stamp(await handle.stat({ bigint: true })); } finally { await handle.close(); }
    } catch (error) { return `error:${(error as NodeJS.ErrnoException).code ?? "unknown"}`; }
  }

  private async load(): Promise<ParsedGrants | undefined> {
    let handle;
    try { handle = await open(this.path(), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      if (code !== "ENOENT") this.warn(`error:${code}`, `cannot open (${code})`);
      this.cached = undefined;
      return undefined;
    }
    try {
      const info = await handle.stat({ bigint: true });
      const signature = stamp(info);
      if (this.cached?.signature === signature) return this.cached.parsed;
      let parsed: ParsedGrants | undefined;
      try {
        if (!info.isFile()) throw new TypeError("not a regular file");
        if (info.size > BigInt(MAX_GRANTS_BYTES)) throw new TypeError(`larger than ${MAX_GRANTS_BYTES} bytes`);
        parsed = parseWakeFuseGrants(JSON.parse(await handle.readFile("utf8")));
      } catch (error) {
        this.warn(signature, error instanceof Error ? error.message : "unreadable");
      }
      this.cached = { signature, parsed };
      return parsed;
    } catch (error) {
      this.warn("error:stat", error instanceof Error ? error.message : "unreadable");
      return undefined;
    } finally { await handle.close(); }
  }

  private warn(signature: string, detail: string): void {
    if (this.warned === signature) return;
    this.warned = signature;
    // The detail is a parser message about shape, never file content.
    console.error(`daimon: wake fuse grants ignored path=${this.path()}: ${detail}; declared limits apply`);
  }
}

function stamp(info: import("node:fs").BigIntStats): string { return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function allowOnly(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name} has unknown key ${JSON.stringify(key)}`);
}
function extra(value: unknown, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}
