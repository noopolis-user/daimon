import path from "node:path";
import { mkdir } from "node:fs/promises";
import { resolveCodexWakeTimeoutMs, resolveCodexWakeTokenCeiling } from "../../pi/cliSession.js";
import { prepareEngineExecutable, prepareEngineReadiness, readPortableEngineCredentialSecrets, verifyPortableEngineAuth } from "../../runtime/engineReadiness.js";
import { recordTurnUsage, resolveTurnUsageLedgerPath } from "../../runtime/turnUsageLedger.js";
import { recordCodexTurnRequests } from "../../runtime/turnRequestLedger.js";
import { bareMountedToolNamingRule, type RuntimeEngineHooks } from "../runtimeHooks.js";
import { startCodexSubscriptionRealm } from "./codexSubscriptionRealm.js";
import { codexSandboxProtectedPaths, codexSandboxReadablePaths } from "./runtimeSandbox.js";

export const codexRuntimeHooks: RuntimeEngineHooks = {
  runtimeHomeShape: "private",
  hostReadinessOrder: 0,
  async prepareHostReadiness(agents, paths, resources) {
    for (const agent of agents) {
      const canonical = paths.forAgent(agent);
      await canonical.verify();
      await mkdir(path.join(canonical.runtimeHomePath, ".codex"), { mode: 0o700, recursive: true });
      await canonical.verify();
    }
    resources.credentialRealms ??= {};
    resources.credentialRealms.codex = await startCodexSubscriptionRealm(agents.map((agent) => ({ ...agent, runtimeHomePath: paths.forAgent(agent).runtimeHomePath })));
  },
  assertRuntimeLaunch() {},
  async prepareRuntimeReadiness(agent, bus, _broker, credentialRealm) {
    if (credentialRealm === undefined) return prepareEngineReadiness(agent, agent.runtimeHomePath, bus);
    const executable = await prepareEngineExecutable(agent.id, "codex");
    const engineHomePath = path.join(agent.runtimeHomePath, ".codex");
    return { executablePath: executable.executablePath, engineHomePath, async verify() {
      await executable.verify();
      await verifyPortableEngineAuth(agent.id, "codex", engineHomePath);
    } };
  },
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
