import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import { isIP } from "node:net";
import path from "node:path";

const CODEX = ENGINE_DESCRIPTORS.codex.id;
const GROK = ENGINE_DESCRIPTORS.grok.id;
export const GATEWAY_CONFIG_VERSION = "noopolis.daimon.gateway.v1";

export type GatewayConfig = Readonly<{
  host: string;
  port: number;
  keyTablePath: string;
  codex?: Readonly<{ realmPath?: string; bootstrapPath?: string; upstreamBaseUrl?: string; tokenUrl?: string }>;
  /** `command` is the pinned Grok CLI the gateway refreshes with; `scratchPath` holds its short-lived refresh home. */
  grok?: Readonly<{ realmPath?: string; bootstrapPath?: string; upstreamBaseUrl?: string; command?: string; scratchPath?: string }>;
}>;

/**
 * Strict, data-only gateway config. Upstreams are fixed; an override is
 * admitted only for a loopback host, so a config can point the gateway at a
 * local fake in tests but never at an arbitrary remote.
 */
export function parseGatewayConfig(value: unknown): GatewayConfig {
  const source = exact(value, "config", [CODEX, GROK, "host", "key_table_path", "port", "version"], ["key_table_path", "version"]);
  if (source[CODEX] === undefined && source[GROK] === undefined) throw new TypeError("gateway config must serve at least one engine");
  if (source.version !== GATEWAY_CONFIG_VERSION) throw new TypeError("gateway config version is unsupported");
  const host = source.host === undefined ? "127.0.0.1" : source.host;
  if (typeof host !== "string" || isIP(host) === 0) throw new TypeError("gateway host must be an IP address");
  const port = source.port === undefined ? 0 : source.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("gateway port is invalid");
  return {
    host, port,
    keyTablePath: absolute(source.key_table_path, "key_table_path"),
    ...(source[CODEX] === undefined ? {} : { codex: realmConfig(source[CODEX], CODEX, { token_url: "tokenUrl" }, loopbackUrl) }),
    ...(source[GROK] === undefined ? {} : { grok: realmConfig(source[GROK], GROK, { command: "command", scratch_path: "scratchPath" }, absolute) })
  };
}

/** The shared realm members plus each engine's own, every value validated by `parseExtra`. */
function realmConfig(value: unknown, engine: string, extras: Readonly<Record<string, string>>, parseExtra: (value: unknown, label: string) => string): Record<string, string> {
  const section = exact(value, engine, ["bootstrap_path", "realm_path", "upstream_base_url", ...Object.keys(extras)], []);
  const output: Record<string, string> = {};
  if (section.realm_path !== undefined) output.realmPath = absolute(section.realm_path, `${engine}.realm_path`);
  if (section.bootstrap_path !== undefined) output.bootstrapPath = absolute(section.bootstrap_path, `${engine}.bootstrap_path`);
  if (section.upstream_base_url !== undefined) output.upstreamBaseUrl = loopbackUrl(section.upstream_base_url, `${engine}.upstream_base_url`);
  for (const [member, key] of Object.entries(extras)) if (section[member] !== undefined) output[key] = parseExtra(section[member], `${engine}.${member}`);
  return output;
}

function exact(value: unknown, label: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`gateway ${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new TypeError(`gateway ${label} has unsupported member ${key}`);
  for (const key of required) if (record[key] === undefined) throw new TypeError(`gateway ${label} requires ${key}`);
  return record;
}

function absolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) throw new TypeError(`gateway ${label} must be a canonical absolute path`);
  return value;
}

function loopbackUrl(value: unknown, label: string): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new TypeError(`gateway ${label} must be a URL`); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError(`gateway ${label} may only override to a loopback URL`);
  return url.href.replace(/\/+$/u, "");
}
