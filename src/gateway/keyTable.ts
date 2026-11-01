import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const GATEWAY_KEY_TABLE_VERSION = "noopolis.daimon.gateway-keys.v1";
/** Engines a key may be scoped to; AGY is never gatewayed (its terms bar third-party OAuth). */
export const GATEWAY_ENGINES = Object.freeze([ENGINE_DESCRIPTORS.codex.id, ENGINE_DESCRIPTORS.grok.id] as const);
export type GatewayEngine = (typeof GATEWAY_ENGINES)[number];
export type GatewayKeyEntry = Readonly<{ agentId: string; engines: readonly GatewayEngine[]; digest: string }>;
export type GatewayKeyTable = Readonly<{ lookup(presented: string | undefined): GatewayKeyEntry | undefined; size: number }>;

const MAX_KEY_TABLE_BYTES = 1_048_576;
const MAX_PRESENTED_KEY_LENGTH = 512;

/**
 * `{ version, keys: { <sha256(key) hex>: { agent_id, engines } } }`. The table
 * holds digests only, so reading it never yields a usable key.
 */
export function parseGatewayKeyTable(value: unknown): GatewayKeyTable {
  const source = plain(value, "key table");
  if (source.version !== GATEWAY_KEY_TABLE_VERSION || Object.keys(source).sort().join(",") !== "keys,version") throw new TypeError("gateway key table has an unsupported shape");
  const entries: { agentId: string; engines: readonly GatewayEngine[]; digest: Buffer; hex: string }[] = [];
  for (const [hex, raw] of Object.entries(plain(source.keys, "keys"))) {
    if (!/^[0-9a-f]{64}$/u.test(hex)) throw new TypeError("gateway key digest must be lowercase sha256 hex");
    const entry = plain(raw, "key entry");
    if (Object.keys(entry).sort().join(",") !== "agent_id,engines") throw new TypeError("gateway key entry has unsupported members");
    if (typeof entry.agent_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.agent_id)) throw new TypeError("gateway key agent_id is invalid");
    const engines = entry.engines;
    if (!Array.isArray(engines) || engines.length === 0 || new Set(engines).size !== engines.length || !engines.every((engine) => (GATEWAY_ENGINES as readonly unknown[]).includes(engine))) throw new TypeError("gateway key engines are invalid");
    entries.push({ agentId: entry.agent_id, engines: Object.freeze([...engines] as GatewayEngine[]), digest: Buffer.from(hex, "hex"), hex });
  }
  return {
    size: entries.length,
    lookup(presented) {
      if (typeof presented !== "string" || presented.length < 16 || presented.length > MAX_PRESENTED_KEY_LENGTH) return undefined;
      const digest = createHash("sha256").update(presented, "utf8").digest();
      let match: (typeof entries)[number] | undefined;
      // Compare against every entry so timing names neither the match nor its position.
      for (const entry of entries) if (timingSafeEqual(entry.digest, digest) && match === undefined) match = entry;
      return match === undefined ? undefined : { agentId: match.agentId, engines: match.engines, digest: match.hex };
    }
  };
}

export async function readGatewayKeyTable(file: string): Promise<GatewayKeyTable> {
  const handle = await open(file, constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o007) !== 0 || stat.size > MAX_KEY_TABLE_BYTES) throw new Error("gateway key table must be a private regular file");
    return parseGatewayKeyTable(JSON.parse((await handle.readFile()).toString("utf8")));
  } finally {
    await handle.close();
  }
}

export const gatewayKeyDigest = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`gateway ${label} must be an object`);
  return value as Record<string, unknown>;
}
