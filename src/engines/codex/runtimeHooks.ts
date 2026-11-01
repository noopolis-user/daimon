import path from "node:path";
import { ensureRuntimeHomeDirectory } from "../../runtime/runtimeHomeLayout.js";
import { resolveCodexWakeTimeoutMs, resolveCodexWakeTokenCeiling } from "../../pi/cliSession.js";
import { prepareEngineExecutable, prepareEngineReadiness, readPortableEngineCredentialSecrets, verifyPortableEngineAuth } from "../../runtime/engineReadiness.js";
import { recordTurnUsage, resolveTurnUsageLedgerPath } from "../../runtime/turnUsageLedger.js";
import { recordCodexTurnRequests } from "../../runtime/turnRequestLedger.js";
import { bareMountedToolNamingRule, type RuntimeEngineHooks } from "../runtimeHooks.js";
import { startCodexSubscriptionRealm } from "./codexSubscriptionRealm.js";
import { assertNoCodexHomeCredential, codexGatewayFromEnvironment, codexGatewayRealm, verifyCodexGateway } from "./gatewayProvider.js";
import { codexSandboxProtectedPaths, codexSandboxReadablePaths } from "./runtimeSandbox.js";

export const codexRuntimeHooks: RuntimeEngineHooks = {
  runtimeHomeShape: "private",
  hostReadinessOrder: 0,
  async prepareHostReadiness(agents, paths, resources, realmPaths) {
    for (const agent of agents) {
      const canonical = paths.forAgent(agent);
      await canonical.verify();
      await ensureRuntimeHomeDirectory(canonical.runtimeHomePath, ".codex");
      await canonical.verify();
    }
    resources.credentialRealms ??= {};
    // The gateway is the sole holder of the login; no realm lease or per-wake copy here.
    if (codexGatewayFromEnvironment() !== undefined) { resources.credentialRealms.codex = codexGatewayRealm(); return; }
    resources.credentialRealms.codex = await startCodexSubscriptionRealm(agents.map((agent) => ({ ...agent, runtimeHomePath: paths.forAgent(agent).runtimeHomePath })), realmPaths);
  },
  assertRuntimeLaunch() {},
  async prepareRuntimeReadiness(agent, bus, _broker, credentialRealm) {
    const gateway = codexGatewayFromEnvironment();
    if (gateway !== undefined) {
      const executable = await prepareEngineExecutable(agent.id, "codex");
      const engineHomePath = path.join(agent.runtimeHomePath, ".codex");
      const verify = async (): Promise<void> => {
        await executable.verify();
        await assertNoCodexHomeCredential(agent.id, engineHomePath);
        await verifyCodexGateway(agent.id, gateway);
      };
      await verify();
      return { executablePath: executable.executablePath, engineHomePath, verify };
    }
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
      credentialSecretValues: () => {
        const gateway = codexGatewayFromEnvironment();
        return gateway === undefined ? readPortableEngineCredentialSecrets(agent.id, "codex", engineHomePath) : Promise.resolve([gateway.key]);
      }
    };
  },
  runtimeToolName: (name) => name,
  mountedToolNamingRule: bareMountedToolNamingRule,
  runtimeHarnessToolNames: (agent) => agent.engine.codexSandbox === undefined ? undefined : []
};
