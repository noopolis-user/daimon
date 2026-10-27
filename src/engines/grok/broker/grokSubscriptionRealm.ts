import { GROK_SUBSCRIPTION_REALM } from "../../../runtime/contractManifest.js";
import { createPortableSubscriptionRealm } from "../../../runtime/portableSubscriptionRealm.js";
import { asGrokAuthenticationRejected } from "./grokAuthenticationError.js";
import type { GrokAgent, GrokSubscriptionRealm, GrokSubscriptionRealmOptions } from "./grokSubscriptionRealmTypes.js";
export type { GrokSubscriptionRealm, GrokSubscriptionRealmOptions } from "./grokSubscriptionRealmTypes.js";

let startRealm: ReturnType<typeof createPortableSubscriptionRealm> | undefined;
const realm = () => startRealm ??= createPortableSubscriptionRealm({
  engine: "grok", title: "Grok", contract: GROK_SUBSCRIPTION_REALM,
  isAuthenticationRejected: (error) => asGrokAuthenticationRejected(error) !== undefined
});
export const startGrokSubscriptionRealm = (agents: readonly GrokAgent[], options: GrokSubscriptionRealmOptions = {}): Promise<GrokSubscriptionRealm> => realm()(agents, options);
