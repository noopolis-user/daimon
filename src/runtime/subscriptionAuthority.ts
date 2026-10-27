import { ENGINE_DESCRIPTORS, type EngineKind } from "../engines/descriptors.js";
import type { RuntimeHostResources } from "../engines/runtimeHooks.js";

/** Fail closed when a new subscription engine has no production owner. */
export function assertSubscriptionAuthority(engine: EngineKind, resources: RuntimeHostResources): void {
  const descriptor = ENGINE_DESCRIPTORS[engine];
  switch (descriptor.auth.staging) {
    case "portable-realm":
    case "secret-service":
      if (resources.credentialRealms?.[engine] !== undefined) return;
      break;
    case "broker-realm":
      if (resources.subscriptionBrokers?.[engine] !== undefined) return;
      break;
  }
  throw new Error(`${engine} subscription requires its shared runtime credential authority`);
}
