import { CODEX_SUBSCRIPTION_REALM } from "../../runtime/contractManifest.js";
import { createPortableSubscriptionRealm } from "../../runtime/portableSubscriptionRealm.js";
export type { PortableSubscriptionRealm as CodexSubscriptionRealm, PortableSubscriptionRealmOptions as CodexSubscriptionRealmOptions } from "../../runtime/portableSubscriptionRealmTypes.js";

export function codexAuthenticationRejected(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /refresh_token_(?:reused|invalidated|expired)|token_revoked|Your refresh token has already been used|refresh token (?:was already used|has expired)|session has ended/iu.test(error.message);
}
let startRealm: ReturnType<typeof createPortableSubscriptionRealm> | undefined;
export const startCodexSubscriptionRealm: ReturnType<typeof createPortableSubscriptionRealm> = (agents, options) => (startRealm ??= createPortableSubscriptionRealm({
  engine: "codex", title: "Codex", contract: CODEX_SUBSCRIPTION_REALM,
  isAuthenticationRejected: codexAuthenticationRejected
}))(agents, options);
