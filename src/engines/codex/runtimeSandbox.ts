import path from "node:path";
import { CODEX_SUBSCRIPTION_REALM } from "../../runtime/contractManifest.js";
import type { OrganizationRuntimeAgentConfig } from "../../runtime/organizationRuntime.js";
import { engineAuthFile } from "../../runtime/engineReadiness.js";
import { grokSandboxProtectedPaths } from "../grok/runtimeSandbox.js";

export function codexSandboxProtectedPaths(
  currentAgentId: string,
  currentAgent: OrganizationRuntimeAgentConfig,
  currentEngineHomePath: string,
  organizationAgents: readonly OrganizationRuntimeAgentConfig[],
  sharedProtectedPaths: readonly string[] = []
): readonly string[] {
  return [...new Set([
    engineAuthFile("codex", currentEngineHomePath),
    path.join(currentAgent.runtimeHomePath, ".daimon-inbound"),
    CODEX_SUBSCRIPTION_REALM.bootstrapMountPath,
    CODEX_SUBSCRIPTION_REALM.durableMountPath,
    "/proc",
    "/run",
    ...grokSandboxProtectedPaths(currentAgentId, organizationAgents, sharedProtectedPaths)
  ])];
}

export function codexSandboxReadablePaths(currentAgent: OrganizationRuntimeAgentConfig): readonly string[] {
  return [path.join(currentAgent.runtimeHomePath, "tool-output")];
}
