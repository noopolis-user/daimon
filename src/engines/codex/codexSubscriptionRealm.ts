import { CODEX_SUBSCRIPTION_REALM } from "../../runtime/contractManifest.js";
import { createPortableSubscriptionRealm } from "../../runtime/portableSubscriptionRealm.js";
export type { PortableSubscriptionRealm as CodexSubscriptionRealm, PortableSubscriptionRealmOptions as CodexSubscriptionRealmOptions } from "../../runtime/portableSubscriptionRealmTypes.js";

let startRealm: ReturnType<typeof createPortableSubscriptionRealm> | undefined;
/** The Codex realm the auth gateway holds for life. */
export const startCodexSubscriptionRealm: ReturnType<typeof createPortableSubscriptionRealm> = (options) =>
  (startRealm ??= createPortableSubscriptionRealm({ engine: "codex", title: "Codex", contract: CODEX_SUBSCRIPTION_REALM }))(options);
