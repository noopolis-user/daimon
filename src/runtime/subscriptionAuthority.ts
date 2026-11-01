import { ENGINE_DESCRIPTORS, type EngineKind } from "../engines/descriptors.js";
import type { RuntimeHostResources } from "../engines/runtimeHooks.js";
import { gatewayFromEnvironment } from "../gateway/agentGateway.js";

/** Fail closed when a new subscription engine has no production owner. */
export function assertSubscriptionAuthority(engine: EngineKind, resources: RuntimeHostResources, environment: NodeJS.ProcessEnv = process.env): void {
  const descriptor = ENGINE_DESCRIPTORS[engine];
  switch (descriptor.auth.staging) {
    case "portable-realm":
      // The auth gateway is the sole holder of a portable login.
      if (gatewayFromEnvironment(environment) !== undefined) return;
      break;
    case "secret-service":
      if (resources.credentialRealms?.[engine] !== undefined) return;
      break;
    case "broker-realm":
      if (resources.subscriptionBrokers?.[engine] !== undefined) return;
      break;
  }
  throw new Error(`${engine} subscription requires its shared runtime credential authority`);
}
