import { isIP } from "node:net";
import path from "node:path";

export const GATEWAY_CONFIG_VERSION = "noopolis.daimon.gateway.v1";

export type GatewayConfig = Readonly<{
  host: string;
  port: number;
  keyTablePath: string;
  codex: Readonly<{ realmPath?: string; bootstrapPath?: string; upstreamBaseUrl?: string; tokenUrl?: string }>;
}>;

/**
 * Strict, data-only gateway config. Upstreams are fixed; an override is
 * admitted only for a loopback host, so a config can point the gateway at a
 * local fake in tests but never at an arbitrary remote.
 */
export function parseGatewayConfig(value: unknown): GatewayConfig {
  const source = exact(value, "config", ["codex", "host", "key_table_path", "port", "version"], ["codex", "key_table_path", "version"]);
  if (source.version !== GATEWAY_CONFIG_VERSION) throw new TypeError("gateway config version is unsupported");
  const host = source.host === undefined ? "127.0.0.1" : source.host;
  if (typeof host !== "string" || isIP(host) === 0) throw new TypeError("gateway host must be an IP address");
  const port = source.port === undefined ? 0 : source.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("gateway port is invalid");
  const codex = exact(source.codex, "codex", ["bootstrap_path", "realm_path", "token_url", "upstream_base_url"], []);
  return {
    host, port,
    keyTablePath: absolute(source.key_table_path, "key_table_path"),
    codex: {
      ...(codex.realm_path === undefined ? {} : { realmPath: absolute(codex.realm_path, "codex.realm_path") }),
      ...(codex.bootstrap_path === undefined ? {} : { bootstrapPath: absolute(codex.bootstrap_path, "codex.bootstrap_path") }),
      ...(codex.upstream_base_url === undefined ? {} : { upstreamBaseUrl: loopbackUrl(codex.upstream_base_url, "codex.upstream_base_url") }),
      ...(codex.token_url === undefined ? {} : { tokenUrl: loopbackUrl(codex.token_url, "codex.token_url") })
    }
  };
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
