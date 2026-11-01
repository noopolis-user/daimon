import path from "node:path";
import { resolveEngineWakeLimitOverrides } from "../../pi/cliSession.js";
import type { PiWakeEnvironmentContextRef } from "../../pi/piAgentWakeSupport.js";
import type { OrganizationRuntimeAgentConfig } from "../../runtime/organizationRuntime.js";
import { engineHomeName, prepareEngineExecutable } from "../../runtime/engineReadiness.js";
import type { RuntimeEngineHooks } from "../runtimeHooks.js";
import { EngineBrokerControlClient, type EngineBrokerTurnClient } from "./broker/engineBrokerControlClient.js";
import { brokerProcessClock } from "./broker/grokBrokerTaskClock.js";
import { grokDaimonToolName, grokMountedToolNamingRule } from "./broker/grokWorkerContract.js";
import { assertGrokRuntimeHomeDirectory } from "./runtimeDirectory.js";

/** Grok runs only through the engine broker: the agent process never holds a Grok login. */
export const grokRuntimeHooks: RuntimeEngineHooks = {
  runtimeHomeShape: "worker-traversable",
  assertRuntimeHomeDirectory: assertGrokRuntimeHomeDirectory,
  hostReadinessOrder: 1,
  async prepareHostReadiness(_agents, _paths, resources) {
    resources.grokBroker = new EngineBrokerControlClient();
    await resources.grokBroker.ready();
    resources.subscriptionBrokers ??= {};
    resources.subscriptionBrokers.grok = resources.grokBroker;
  },
  assertRuntimeLaunch(agent, broker) {
    if (broker === undefined) throw new Error(`Agent ${agent.id} runs Grok, which requires the engine broker`);
  },
  async prepareRuntimeReadiness(agent) {
    return { ...(await prepareEngineExecutable(agent.id, "grok")), engineHomePath: path.join(agent.runtimeHomePath, engineHomeName("grok")) };
  },
  runtimeSandbox: () => ({}),
  runtimeSessionOptions({ agent, grokBroker, wakeEnvironmentContext }) {
    if (grokBroker === undefined) throw new Error(`Agent ${agent.id} runs Grok, which requires the engine broker`);
    return { grokBrokerTurn: grokBrokerTurnFor(agent, grokBroker, wakeEnvironmentContext) };
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
