import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import type { GrokRealmOwner } from "./grokRealmOwner.js";
import { createChatCompletionsUsageTap } from "./relay.js";
import type { GatewayRoute } from "./route.js";

export const GROK_UPSTREAM_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
/** Exactly what the Grok broker proxy forwards (`grokBrokerProxyRequest.ts`); nothing else is bought. */
export const GROK_GATEWAY_ROUTES = Object.freeze(["POST /chat/completions"] as const);

export function grokGatewayRoute(options: Readonly<{ owner: GrokRealmOwner; upstreamBaseUrl?: string }>): GatewayRoute {
  return {
    engine: ENGINE_DESCRIPTORS.grok.id,
    upstreamBaseUrl: options.upstreamBaseUrl ?? GROK_UPSTREAM_BASE_URL,
    routes: GROK_GATEWAY_ROUTES,
    query: false,
    owner: options.owner,
    applyBearer(headers, bearer) { headers.authorization = `Bearer ${bearer.accessToken}`; },
    usageTap: createChatCompletionsUsageTap
  };
}
