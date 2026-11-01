import type { AgentGateway } from "../../../gateway/agentGateway.js";
import { ENGINE_DESCRIPTORS } from "../../descriptors.js";
import { ENGINE_BROKER_AUTH_STALE } from "./engineBrokerProtocol.js";
import { GrokBrokerProxyRefusal, type GrokBrokerUpstream } from "./grokBrokerProxy.js";
import { GrokGatewayTransportFault } from "./grokBrokerUpstreamFault.js";

const MAX_GATEWAY_ERROR_BYTES = 8 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;
const TRANSPORT_CODES = new Map([[502, "upstream_unavailable"], [504, "upstream_timeout"]] as const);

/**
 * The broker's credential authority in gateway mode. It holds no Grok token and
 * no realm lease: the "bearer" it hands the proxy is the broker's own gateway
 * key, which can only buy Grok inference through the gateway. There is nothing
 * to refresh here; the gateway owns refresh, so a gateway 401 is never treated
 * as a token problem. A gateway `auth_stale` fences this broker exactly as a
 * rejected local refresh does (stale until restart), so turns and grants
 * refuse it by name before any further upstream call.
 *
 * `initialize()` is the readiness probe: the gateway's health route must
 * answer 200 for this key with Grok among its engines. `auth_stale` there
 * fences before the broker reports ready.
 */
export type GrokGatewayAuthority = Readonly<{
  initialize(): Promise<void>;
  accessToken(forceRefresh: boolean): Promise<string>;
  markRejected(rejectedTokenDigest?: string): Promise<void>;
  isStale(): boolean;
  /** The gateway answered `auth_stale`. */
  fence(): void;
}>;

export function createGrokGatewayAuthority(gateway: AgentGateway, fetcher: typeof fetch = fetch): GrokGatewayAuthority {
  let stale = false;
  return {
    async initialize() {
      let status = 0;
      let body: { error?: unknown; engines?: unknown } | undefined;
      try {
        const response = await fetcher(`${gateway.url}/v1/health`, { headers: { authorization: `Bearer ${gateway.key}` }, redirect: "error", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        status = response.status;
        body = await response.json().catch(() => undefined) as typeof body;
      } catch { status = 0; }
      if (status === 403 && body?.error === ENGINE_BROKER_AUTH_STALE) stale = true;
      if (status !== 200 || !Array.isArray(body?.engines) || !body.engines.includes(ENGINE_DESCRIPTORS.grok.id)) throw new Error("Grok broker auth gateway is not ready");
    },
    accessToken: async () => {
      if (stale) throw new Error("Grok broker credential authority unavailable");
      return gateway.key;
    },
    markRejected: async () => { stale = true; throw new Error("Grok broker credential authority unavailable"); },
    isStale: () => stale,
    fence: () => { stale = true; }
  };
}

/**
 * Sends the proxy's authorized request to `<gateway>/v1/grok/chat/completions`
 * instead of the provider. The request already carries the gateway key as its
 * bearer (`authorizeGrokBrokerProxyRequest` with the gateway authority).
 *
 * Status mapping (gateway contract): 401 means the broker's key was refused,
 * a named non-retryable refusal, never a refresh; 403 `auth_stale` fences the
 * broker; any other 403 is a named refusal; 429 and 5xx are relayed as the
 * provider's own answer, so the proxy's metering sees them unchanged.
 */
export function createGrokGatewayUpstream(gateway: AgentGateway, authority: GrokGatewayAuthority, fetcher: typeof fetch = fetch): GrokBrokerUpstream {
  const target = `${gateway.url}/v1/${ENGINE_DESCRIPTORS.grok.id}/chat/completions`;
  return async (request, signal) => {
    const result = await fetcher(target, { method: "POST", headers: request.headers, body: Buffer.from(request.body), redirect: "error", ...(signal === undefined ? {} : { signal }) });
    if (result.status === 401) {
      await result.body?.cancel().catch(() => undefined);
      throw new GrokBrokerProxyRefusal("gateway_unauthorized");
    }
    const transport = TRANSPORT_CODES.get(result.status as 502 | 504);
    if (transport !== undefined) {
      // A relayed provider 502/504 keeps its own body; only the gateway's named answer is a transport fault.
      const bytes = new Uint8Array(await result.arrayBuffer());
      if (errorCode(bytes) === transport) throw new GrokGatewayTransportFault(transport);
      return { status: result.status, headers: { "content-type": result.headers.get("content-type") ?? "application/json" }, body: bytes };
    }
    if (result.status === 403) {
      const code = errorCode(new Uint8Array(await result.arrayBuffer()));
      if (code === ENGINE_BROKER_AUTH_STALE) { authority.fence(); throw new GrokBrokerProxyRefusal(ENGINE_BROKER_AUTH_STALE); }
      throw new GrokBrokerProxyRefusal("gateway_forbidden");
    }
    return { status: result.status, headers: { "content-type": result.headers.get("content-type") ?? "application/json" }, body: new Uint8Array(await result.arrayBuffer()) };
  };
}

function errorCode(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > MAX_GATEWAY_ERROR_BYTES) return undefined;
  try {
    const error = (JSON.parse(Buffer.from(bytes).toString("utf8")) as { error?: unknown }).error;
    return typeof error === "string" ? error : undefined;
  } catch { return undefined; }
}
