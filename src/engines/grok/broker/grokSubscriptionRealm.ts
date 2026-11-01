import { GROK_SUBSCRIPTION_REALM } from "../../../runtime/contractManifest.js";
import { createPortableSubscriptionRealm } from "../../../runtime/portableSubscriptionRealm.js";
export type { PortableSubscriptionRealm as GrokSubscriptionRealm, PortableSubscriptionRealmOptions as GrokSubscriptionRealmOptions } from "../../../runtime/portableSubscriptionRealmTypes.js";

let startRealm: ReturnType<typeof createPortableSubscriptionRealm> | undefined;
/** The Grok realm the auth gateway holds for life. */
export const startGrokSubscriptionRealm: ReturnType<typeof createPortableSubscriptionRealm> = (options) =>
  (startRealm ??= createPortableSubscriptionRealm({ engine: "grok", title: "Grok", contract: GROK_SUBSCRIPTION_REALM }))(options);
