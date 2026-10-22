import type { OrganizationRuntimeAgentConfig } from "../../runtime/organizationRuntime.js";
import { AGY_SUBSCRIPTION_REALM, GROK_SUBSCRIPTION_REALM } from "../../runtime/contractManifest.js";

export function grokSandboxProtectedPaths(
  currentAgentId: string,
  organizationAgents: readonly OrganizationRuntimeAgentConfig[],
  sharedProtectedPaths: readonly string[] = []
): readonly string[] {
  return [
    GROK_SUBSCRIPTION_REALM.bootstrapMountPath,
    GROK_SUBSCRIPTION_REALM.durableMountPath,
    ...(organizationAgents.some((peer) => peer.engine.kind === "agy") ? [
      AGY_SUBSCRIPTION_REALM.unlockMountPath,
      AGY_SUBSCRIPTION_REALM.durableMountPath
    ] : []),
    ...sharedProtectedPaths,
    ...organizationAgents.filter((peer) => peer.id !== currentAgentId)
      .flatMap((peer) => [peer.runtimeHomePath, peer.workspacePath])
  ];
}
