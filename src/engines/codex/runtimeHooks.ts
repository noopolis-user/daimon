import { resolveCodexWakeTimeoutMs, resolveCodexWakeTokenCeiling } from "../../pi/cliSession.js";
import { prepareEngineReadiness, readPortableEngineCredentialSecrets } from "../../runtime/engineReadiness.js";
import { recordTurnUsage, resolveTurnUsageLedgerPath } from "../../runtime/turnUsageLedger.js";
import { recordCodexTurnRequests } from "../../runtime/turnRequestLedger.js";
import { bareMountedToolNamingRule, type RuntimeEngineHooks } from "../runtimeHooks.js";
import { materializePortableCredential } from "./portableCredentialMaterial.js";
import { codexSandboxProtectedPaths, codexSandboxReadablePaths } from "./runtimeSandbox.js";

export const codexRuntimeHooks: RuntimeEngineHooks = {
  runtimeHomeShape: "private",
  hostReadinessOrder: 0,
  async prepareHostReadiness(agents, paths) {
    for (const agent of agents) {
      const canonical = paths.forAgent(agent);
      await canonical.verify();
      await materializePortableCredential(agent, canonical.runtimeHomePath);
      await canonical.verify();
    }
  },
  assertRuntimeLaunch() {},
  prepareRuntimeReadiness: (agent, bus) => prepareEngineReadiness(agent, agent.runtimeHomePath, bus),
  runtimeSandbox({ agent, readiness, organizationAgents, sharedProtectedPaths }) {
    return agent.engine.codexSandbox === undefined ? {} : { codexSandboxPaths: {
      protectedPaths: codexSandboxProtectedPaths(agent.id, agent, readiness.engineHomePath, organizationAgents ?? [agent], sharedProtectedPaths),
      readablePaths: codexSandboxReadablePaths(agent)
    } };
  },
  runtimeSessionOptions({ agent, engineHomePath, wakeEnvironmentContext, sandbox }) {
    return {
      onTurnUsage: (usage, outcome) => recordTurnUsage(resolveTurnUsageLedgerPath(), { agent: agent.id, wake: wakeEnvironmentContext.current ?? "wake", engine: "codex", usage, outcome }),
      onCodexTurnRequests: (threadId) => recordCodexTurnRequests({ agent: agent.id, wake: wakeEnvironmentContext.current ?? "wake", codexHome: engineHomePath, threadId }).then(() => undefined),
      timeoutMs: resolveCodexWakeTimeoutMs(),
      codexTokenCeiling: resolveCodexWakeTokenCeiling(),
      ...(agent.engine.model === undefined ? {} : { model: agent.engine.model }),
      ...(agent.engine.reasoningEffort === undefined ? {} : { reasoningEffort: agent.engine.reasoningEffort }),
      ...(agent.engine.codexSandbox === undefined ? {} : { codexSandbox: agent.engine.codexSandbox }),
      ...(sandbox.codexSandboxPaths === undefined ? {} : {
        codexSandboxProtectedPaths: sandbox.codexSandboxPaths.protectedPaths,
        codexSandboxReadablePaths: sandbox.codexSandboxPaths.readablePaths
      }),
      credentialSecretValues: () => readPortableEngineCredentialSecrets(agent.id, "codex", engineHomePath)
    };
  },
  runtimeToolName: (name) => name,
  mountedToolNamingRule: bareMountedToolNamingRule,
  runtimeHarnessToolNames: (agent) => agent.engine.codexSandbox === undefined ? undefined : []
};
