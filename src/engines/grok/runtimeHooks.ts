import path from "node:path";
import { resolveEngineWakeLimitOverrides } from "../../pi/cliSession.js";
import type { PiWakeEnvironmentContextRef } from "../../pi/piAgentWakeSupport.js";
import type { OrganizationRuntimeAgentConfig } from "../../runtime/organizationRuntime.js";
import { engineHomeName, prepareEngineExecutable, prepareEngineReadiness, readPortableEngineCredentialSecrets } from "../../runtime/engineReadiness.js";
import type { RuntimeEngineHooks } from "../runtimeHooks.js";
import { EngineBrokerControlClient, type EngineBrokerTurnClient } from "./broker/engineBrokerControlClient.js";
import { brokerProcessClock } from "./broker/grokBrokerTaskClock.js";
import { grokDaimonToolName, grokMountedToolNamingRule } from "./broker/grokWorkerContract.js";
import { GROK_DAIMON_SANDBOX_PROFILE, prepareAndVerifyGrokSandbox } from "./grokSandbox.js";
import { assertGrokRuntimeHomeDirectory } from "./runtimeDirectory.js";
import { grokSandboxProtectedPaths } from "./runtimeSandbox.js";

export const grokRuntimeHooks: RuntimeEngineHooks = {
  runtimeHomeShape: "worker-traversable",
  assertRuntimeHomeDirectory: assertGrokRuntimeHomeDirectory,
  hostReadinessOrder: 1,
  async prepareHostReadiness(_agents, _paths, resources) {
    resources.grokBroker = new EngineBrokerControlClient();
    await resources.grokBroker.ready();
  },
  assertRuntimeLaunch(agent, broker) {
    if (agent.engine.model !== undefined && broker === undefined) throw new Error(`Agent ${agent.id} declares a Grok model, which requires the engine broker`);
  },
  async prepareRuntimeReadiness(agent, bus, broker) {
    return broker === undefined ? prepareEngineReadiness(agent, agent.runtimeHomePath, bus)
      : { ...(await prepareEngineExecutable(agent.id, "grok")), engineHomePath: path.join(agent.runtimeHomePath, engineHomeName("grok")) };
  },
  runtimeSandbox({ agent, readiness, paths, organizationAgents, sharedProtectedPaths }) {
    return paths === undefined || organizationAgents === undefined ? {} : {
      verifyGrokSandbox: () => prepareAndVerifyGrokSandbox({
        command: readiness.executablePath,
        cwd: agent.workspacePath,
        engineHomePath: readiness.engineHomePath,
        protectedPaths: grokSandboxProtectedPaths(agent.id, organizationAgents, sharedProtectedPaths),
        runtimeHomePath: agent.runtimeHomePath
      })
    };
  },
  runtimeSessionOptions({ agent, engineHomePath, grokBroker, wakeEnvironmentContext, sandbox }) {
    return {
      ...(grokBroker === undefined ? {
        credentialSecretValues: () => readPortableEngineCredentialSecrets(agent.id, "grok", engineHomePath)
      } : { grokBrokerTurn: grokBrokerTurnFor(agent, grokBroker, wakeEnvironmentContext) }),
      ...(sandbox.verifyGrokSandbox === undefined ? {} : {
        grokSandboxProfile: GROK_DAIMON_SANDBOX_PROFILE,
        verifyGrokSandbox: sandbox.verifyGrokSandbox
      })
    };
  },
  runtimeToolName: grokDaimonToolName,
  mountedToolNamingRule: grokMountedToolNamingRule,
  runtimeHarnessToolNames: () => undefined
};

/** @internal The production callback; no native clock enters the engine environment. */
export function grokBrokerTurnFor(agent: OrganizationRuntimeAgentConfig, grokBroker: EngineBrokerTurnClient, wakeEnvironmentContext: PiWakeEnvironmentContextRef) {
  const limits = resolveEngineWakeLimitOverrides();
  const options = { ...(limits === undefined ? {} : { limits }), ...(agent.engine.model === undefined ? {} : { model: agent.engine.model }) };
  return (prompt: string, endpoint: string, signal: AbortSignal) => {
    const processClock = brokerProcessClock();
    return grokBroker.turn(agent.id, wakeEnvironmentContext.current ?? "wake", prompt, endpoint, signal, { ...options, ...(processClock === undefined ? {} : { processClock }) });
  };
}
