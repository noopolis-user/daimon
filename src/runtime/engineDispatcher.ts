import path from "node:path";
import type { AgentHandle } from "../core/types.js";
import { getEngineHandler } from "../engines/registry.js";
import { createCliSessionFactory } from "../pi/cliSession.js";
import { reportEngineTaskClockGap } from "../pi/engineTaskClock.js";
import { memoryClockOptions } from "../pi/memoryClock.js";
import { PiHarnessAdapter } from "../pi/piHarness.js";
import type { EngineBrokerTurnClient } from "../engines/grok/broker/engineBrokerControlClient.js";
import { attentionTools, type AttentionRegistry } from "./attention.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import type { OrganizationRuntimePathAuthority } from "./physicalReadiness.js";
import { createProductionAgentTools } from "./productionAgentTools.js";
import { readTaskClock } from "./taskClock.js";

export { codexSandboxProtectedPaths, codexSandboxReadablePaths } from "../engines/codex/runtimeSandbox.js";
export { grokSandboxProtectedPaths } from "../engines/grok/runtimeSandbox.js";
export { grokBrokerTurnFor } from "../engines/grok/runtimeHooks.js";

/**
 * The production-only bridge from a closed runtime engine intent to Daimon's
 * existing one-agent harness. Configuration never carries a command or env.
 */
export async function startOrganizationRuntimeEngine(
  agent: OrganizationRuntimeAgentConfig,
  controlTokenEnv: string,
  paths?: ReturnType<OrganizationRuntimePathAuthority["forAgent"]>,
  agyBusAddress?: string,
  grokBroker?: EngineBrokerTurnClient,
  organizationAgents?: readonly OrganizationRuntimeAgentConfig[],
  sharedProtectedPaths: readonly string[] = [],
  attention?: AttentionRegistry
): Promise<AgentHandle> {
  const clock = readTaskClock();
  reportEngineTaskClockGap(agent.engine.kind);
  if (agent.memory !== undefined) memoryClockOptions(clock);
  const handler = getEngineHandler(agent.engine.kind);
  handler.assertRuntimeLaunch(agent, grokBroker);
  await paths?.verify();
  const canonicalAgent = paths === undefined ? agent : { ...agent, workspacePath: paths.workspacePath, runtimeHomePath: paths.runtimeHomePath };
  const readiness = await handler.prepareRuntimeReadiness(canonicalAgent, agyBusAddress, grokBroker);
  const wakeContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef = {};
  const sandbox = handler.runtimeSandbox({ agent: canonicalAgent, readiness, paths, organizationAgents, sharedProtectedPaths });
  const mountedTools = [...await createProductionAgentTools(canonicalAgent, wakeContext), ...(agent.attention !== undefined && attention !== undefined ? attentionTools(agent.id, attention) : [])];
  const adapter = adapterFor(canonicalAgent, controlTokenEnv, readiness.verify, readiness.executablePath, readiness.engineHomePath, paths?.verify, agyBusAddress, mountedTools, wakeContext, sandbox, grokBroker, mountedTools.map((tool) => tool.name));
  const handle = await adapter.startAgent({
    id: canonicalAgent.id,
    name: canonicalAgent.name,
    instructions: canonicalAgent.instructions,
    runtimeHomePath: canonicalAgent.runtimeHomePath,
    workspacePath: canonicalAgent.workspacePath
  });
  await paths?.verify();
  const result: AgentHandle = {
    ...handle,
    async wake(event) {
      await paths?.verify();
      await readiness.verify();
      try { return await handle.wake(event); } finally { await paths?.verify(); await readiness.verify(); }
    },
    async stop() { await handle.stop(); },
    status: () => handle.status()
  };
  return result;
}

function adapterFor(
  agent: OrganizationRuntimeAgentConfig,
  controlTokenEnv: string,
  verifyExecutable: () => Promise<void>,
  executablePath: string,
  engineHomePath: string,
  verifyRuntimePaths?: () => Promise<void>,
  agyBusAddress?: string,
  productionTools: readonly import("@earendil-works/pi-coding-agent").ToolDefinition[] = [],
  wakeEnvironmentContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef = {},
  sandbox: import("../engines/runtimeHooks.js").RuntimeSandbox = {},
  grokBroker?: EngineBrokerTurnClient,
  mountedToolNames: readonly string[] = []
): PiHarnessAdapter {
  const engine = agent.engine.kind;
  const sessionFactory = createCliSessionFactory({
    engine,
    redactedEnvironmentNames: [controlTokenEnv],
    identityPrompt: identityEnvelope(agent, mountedToolNames),
    command: executablePath,
    engineHomePath,
    verifyExecutable,
    verifyRuntimePaths,
    ...getEngineHandler(engine).runtimeSessionOptions({ agent, engineHomePath, agyBusAddress, grokBroker, wakeEnvironmentContext, sandbox })
  });
  return cliHarness(agent, sessionFactory, [controlTokenEnv], productionTools, wakeEnvironmentContext);
}

/**
 * CLI engines do not consume Pi's resource loader. Frame the same immutable
 * identity in JSON so arbitrary names/instructions cannot change its shape.
 */
/**
 * The caller-owned prompt preamble.
 *
 * It names the mounted tools explicitly, because a CLI engine reaches Daimon's
 * tools over MCP and an agent whose instructions name another engine's tool
 * spelling can finish a turn having called nothing. The declared names are the
 * caller's own configuration, not engine-supplied text.
 *
 * On Grok the bare names are not the callable ones: every Daimon tool is a
 * deferred MCP tool of server `daimon`, and Grok 1.0.34 refuses an unqualified
 * name before any HTTP ("Tool names must be qualified as `server__tool`"). This
 * envelope used to instruct exactly that refused form. The correct rule is not
 * restated here — it is rendered by `grokMountedToolNamingRule` in the same
 * contract module that renders the worker's pinned system prompt, so the two
 * texts cannot contradict each other again. Every other engine's sentence is
 * unchanged, byte for byte.
 */
export function identityEnvelope(agent: OrganizationRuntimeAgentConfig, mountedToolNames: readonly string[] = []): string {
  return [
    "<daimon-agent-identity>",
    JSON.stringify({ id: agent.id, name: agent.name, instructions: agent.instructions }),
    "</daimon-agent-identity>",
    ...(mountedToolNames.length === 0 ? [] : [
      getEngineHandler(agent.engine.kind).mountedToolNamingRule(mountedToolNames)
        + " No other tool reaches the newsroom."
    ]),
    // The one tool that reaches colleagues is named the way this engine can
    // call it. Meaning and prohibition are unchanged; only the spelling is.
    `Colleagues only hear you when you call ${engineToolName(agent, "moltnet_send")}; your terminal response is a private note to the runtime, not a message to anyone — keep it to one line or leave it empty. `
      + "Do not seek transport credentials or invoke a transport CLI unless the caller explicitly mounted an authenticated transport tool.",
    "The following is the current wake event."
  ].join("\n") + "\n";
}

/**
 * One Daimon tool name, spelled the way this agent's engine accepts it.
 *
 * On Grok the bare form is refused as an invalid MCP tool name, so any
 * engine-facing sentence that *names* a tool renders it through the contract's
 * `grokDaimonToolName`; every other engine keeps the bare name byte for byte.
 * Grok's own native tools (`read_file`, `search_tool`, `use_tool`) are not
 * Daimon tools and never take the prefix.
 */
const engineToolName = (agent: OrganizationRuntimeAgentConfig, tool: string): string =>
  getEngineHandler(agent.engine.kind).runtimeToolName(tool);

function cliHarness(
  agent: OrganizationRuntimeAgentConfig,
  sessionFactory: ReturnType<typeof createCliSessionFactory>,
  protectedEnvironmentNames: readonly string[], productionTools: readonly import("@earendil-works/pi-coding-agent").ToolDefinition[], wakeEnvironmentContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef
): PiHarnessAdapter {
  const toolNames = getEngineHandler(agent.engine.kind).runtimeHarnessToolNames(agent);
  return new PiHarnessAdapter({
    authPath: path.join(agent.runtimeHomePath, "auth.json"),
    // Pi owns the harness envelope while the session factory owns this CLI.
    model: {
      auth: { method: "none" },
      endpoint: { baseUrl: "http://127.0.0.1/daimon-cli", compatibility: "openai" },
      name: "daimon-cli",
      provider: "daimon-cli"
    },
    sessionFactory,
    protectedEnvironmentNames,
    productionTools,
    ...(toolNames === undefined ? {} : { toolNames: [...toolNames] }),
    wakeEnvironmentContext,
    ...(agent.memory === undefined ? {} : { memory: {
      runtimeHomePath: agent.memory.runtimeHomePath,
      ...(agent.memory.source === undefined ? {} : { source: agent.memory.source }),
      ...(agent.memory.tokenBudget === undefined ? {} : { tokenBudget: agent.memory.tokenBudget })
    } })
  });
}
