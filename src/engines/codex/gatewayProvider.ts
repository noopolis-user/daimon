import { lstat } from "node:fs/promises";
import path from "node:path";
import { PORTABLE_AUTH_FILE_NAME } from "../descriptorContracts.js";

import { DAIMON_GATEWAY_KEY_ENV, gatewayFromEnvironment, type AgentGateway } from "../../gateway/agentGateway.js";

export { DAIMON_GATEWAY_KEY_ENV, DAIMON_GATEWAY_URL_ENV } from "../../gateway/agentGateway.js";
export const CODEX_GATEWAY_PROVIDER_ID = "daimon_gateway";
const HEALTH_TIMEOUT_MS = 5_000;

export type CodexGateway = AgentGateway;
export const codexGatewayFromEnvironment = gatewayFromEnvironment;

/** A Codex agent reaches its subscription only through the auth gateway. */
export function requireCodexGateway(agentId: string): CodexGateway {
  const gateway = codexGatewayFromEnvironment();
  if (gateway === undefined) throw new Error(`agent ${JSON.stringify(agentId)} Codex requires the auth gateway (DAIMON_GATEWAY_URL and DAIMON_GATEWAY_KEY)`);
  return gateway;
}

/** Routes Codex's subscription request through the gateway; HTTP SSE only. */
export function codexGatewayProviderArgs(gateway: CodexGateway): string[] {
  const provider = `{name="daimon-gateway",base_url=${JSON.stringify(`${gateway.url}/v1/codex`)},env_key=${JSON.stringify(DAIMON_GATEWAY_KEY_ENV)},wire_api="responses",supports_websockets=false}`;
  return ["-c", `model_provider=${JSON.stringify(CODEX_GATEWAY_PROVIDER_ID)}`, "-c", `model_providers.${CODEX_GATEWAY_PROVIDER_ID}=${provider}`];
}

/** Readiness: the key is accepted, buys Codex, the realm is live and not stale, and its login is durable. */
export async function verifyCodexGateway(agentId: string, gateway: CodexGateway, fetcher: typeof fetch = fetch): Promise<void> {
  let ready = false;
  try {
    const response = await fetcher(`${gateway.url}/v1/health`, { headers: { authorization: `Bearer ${gateway.key}` }, redirect: "error", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = await response.json().catch(() => undefined) as { engines?: unknown; write_back?: { codex?: unknown } } | undefined;
    ready = response.status === 200 && Array.isArray(body?.engines) && body.engines.includes("codex") && body.write_back?.codex === "ok";
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
