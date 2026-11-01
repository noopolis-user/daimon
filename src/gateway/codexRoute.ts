import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import type { CodexBearer, CodexRealmOwner } from "./codexRealmOwner.js";
import { createUsageTap } from "./relay.js";
import type { GatewayRoute } from "./route.js";

export const CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** The only Codex routes a key can buy; there is no open proxy. */
export const CODEX_GATEWAY_ROUTES = Object.freeze(["POST /responses", "POST /responses/compact", "GET /models"] as const);

export function codexGatewayRoute(options: Readonly<{ owner: CodexRealmOwner; upstreamBaseUrl?: string }>): GatewayRoute {
  return {
    engine: ENGINE_DESCRIPTORS.codex.id,
    upstreamBaseUrl: options.upstreamBaseUrl ?? CODEX_UPSTREAM_BASE_URL,
    routes: CODEX_GATEWAY_ROUTES,
    query: true,
    owner: options.owner,
    applyBearer(headers, bearer) {
      headers.authorization = `Bearer ${bearer.accessToken}`;
      const accountId = (bearer as CodexBearer).accountId;
      if (accountId !== undefined) headers["chatgpt-account-id"] = accountId;
    },
    usageTap: createUsageTap
  };
}
