import { lstat } from "node:fs/promises";
import path from "node:path";
import { PORTABLE_AUTH_FILE_NAME } from "../descriptorContracts.js";
import type { PortableSubscriptionRealm } from "../../runtime/portableSubscriptionRealmTypes.js";

export const DAIMON_GATEWAY_URL_ENV = "DAIMON_GATEWAY_URL";
/**
 * Must keep its `_KEY` suffix: Codex's default shell environment excludes
 * every `*KEY*` name, so the agent key reaches Codex's provider but never a
 * model-run command.
 */
export const DAIMON_GATEWAY_KEY_ENV = "DAIMON_GATEWAY_KEY";
export const CODEX_GATEWAY_PROVIDER_ID = "daimon_gateway";
const HEALTH_TIMEOUT_MS = 5_000;

export type CodexGateway = Readonly<{ url: string; key: string }>;

/** Both variables or neither; half a gateway is a deployment fault, never a silent fallback. */
export function codexGatewayFromEnvironment(environment: NodeJS.ProcessEnv = process.env): CodexGateway | undefined {
  const rawUrl = environment[DAIMON_GATEWAY_URL_ENV];
  const key = environment[DAIMON_GATEWAY_KEY_ENV];
  if ((rawUrl === undefined || rawUrl === "") && (key === undefined || key === "")) return undefined;
  if (!rawUrl || !key) throw new Error(`${DAIMON_GATEWAY_URL_ENV} and ${DAIMON_GATEWAY_KEY_ENV} must be set together`);
  if (!/^[A-Za-z0-9._~+/=-]{16,512}$/u.test(key)) throw new Error(`${DAIMON_GATEWAY_KEY_ENV} is not a gateway key`);
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error(`${DAIMON_GATEWAY_URL_ENV} must be a URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${DAIMON_GATEWAY_URL_ENV} must be a plain http(s) URL`);
  return { url: url.href.replace(/\/+$/u, ""), key };
}

/** Routes Codex's subscription request through the gateway; HTTP SSE only. */
export function codexGatewayProviderArgs(gateway: CodexGateway): string[] {
  const provider = `{name="daimon-gateway",base_url=${JSON.stringify(`${gateway.url}/v1/codex`)},env_key=${JSON.stringify(DAIMON_GATEWAY_KEY_ENV)},wire_api="responses",supports_websockets=false}`;
  return ["-c", `model_provider=${JSON.stringify(CODEX_GATEWAY_PROVIDER_ID)}`, "-c", `model_providers.${CODEX_GATEWAY_PROVIDER_ID}=${provider}`];
}

/** Readiness: the key is accepted, buys Codex, and the realm is not stale. */
export async function verifyCodexGateway(agentId: string, gateway: CodexGateway, fetcher: typeof fetch = fetch): Promise<void> {
  let ready = false;
  try {
    const response = await fetcher(`${gateway.url}/v1/health`, { headers: { authorization: `Bearer ${gateway.key}` }, redirect: "error", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = await response.json().catch(() => undefined) as { engines?: unknown } | undefined;
    ready = response.status === 200 && Array.isArray(body?.engines) && body.engines.includes("codex");
  } catch { ready = false; }
  if (!ready) throw new Error(`agent ${JSON.stringify(agentId)} Codex auth gateway is not ready`);
}

/** Gateway mode keeps no credential in CODEX_HOME; one appearing there is refused. */
export async function assertNoCodexHomeCredential(agentId: string, engineHomePath: string): Promise<void> {
  try {
    await lstat(path.join(engineHomePath, PORTABLE_AUTH_FILE_NAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  throw new Error(`agent ${JSON.stringify(agentId)} Codex home must hold no credential in gateway mode`);
}

/** The gateway owns the login, so a wake needs no lease, copy or promotion. */
export const codexGatewayRealm = (): PortableSubscriptionRealm => ({
  withCredential: (_agent, operation) => operation(),
  close: async () => undefined
});
