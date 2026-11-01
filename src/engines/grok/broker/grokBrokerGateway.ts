import type { AgentGateway } from "../../../gateway/agentGateway.js";
import { ENGINE_DESCRIPTORS } from "../../descriptors.js";
import { ENGINE_BROKER_AUTH_STALE } from "./engineBrokerProtocol.js";
import { GrokBrokerProxyRefusal, type GrokBrokerUpstream } from "./grokBrokerProxy.js";

const MAX_GATEWAY_ERROR_BYTES = 8 * 1024;

/**
 * The broker's credential authority in gateway mode. It holds no Grok token and
 * no realm lease: the "bearer" it hands the proxy is the broker's own gateway
 * key, which can only buy Grok inference through the gateway. There is nothing
 * to refresh here; the gateway owns refresh, so a gateway 401 is never treated
 * as a token problem. A gateway `auth_stale` fences this broker exactly as a
 * rejected local refresh does (stale until restart), so turns and grants
 * refuse it by name before any further upstream call.
 */
export type GrokGatewayAuthority = Readonly<{
  initialize(): Promise<void>;
  accessToken(forceRefresh: boolean): Promise<string>;
  markRejected(rejectedTokenDigest?: string): Promise<void>;
  isStale(): boolean;
  /** The gateway answered `auth_stale`. */
  fence(): void;
}>;

export function createGrokGatewayAuthority(gateway: AgentGateway): GrokGatewayAuthority {
  let stale = false;
  return {
    initialize: async () => undefined,
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
    if (result.status === 403) {
      const code = await gatewayErrorCode(result);
      if (code === ENGINE_BROKER_AUTH_STALE) { authority.fence(); throw new GrokBrokerProxyRefusal(ENGINE_BROKER_AUTH_STALE); }
      throw new GrokBrokerProxyRefusal("gateway_forbidden");
    }
    return { status: result.status, headers: { "content-type": result.headers.get("content-type") ?? "application/json" }, body: new Uint8Array(await result.arrayBuffer()) };
  };
}

async function gatewayErrorCode(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length > MAX_GATEWAY_ERROR_BYTES) return undefined;
    const error = (JSON.parse(text) as { error?: unknown }).error;
    return typeof error === "string" ? error : undefined;
  } catch { return undefined; }
}
