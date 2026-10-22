import { runAgySubscriptionBootstrap } from "./agySubscriptionBootstrap.js";
import { AGY_MAX_TOOL_TURNS } from "../../pi/cliSession.js";
import { prepareEngineExecutable, prepareEngineReadiness, verifyAgySubscriptionEnrollment } from "../../runtime/engineReadiness.js";
import { recordTurnUsage, resolveTurnUsageLedgerPath } from "../../runtime/turnUsageLedger.js";
import { bareMountedToolNamingRule, type RuntimeEngineHooks } from "../runtimeHooks.js";
import { startAgySubscriptionRealm } from "./agySubscriptionRealm.js";

export const agyRuntimeHooks: RuntimeEngineHooks = {
  cliCommandKind: "agy-login",
  parseCliArguments(arguments_) {
    if (arguments_.length === 5 && arguments_[0] === "auth" && arguments_[1] === "agy" && arguments_[2] === "login"
      && arguments_[3] === "--config" && arguments_[4]) return { configPath: arguments_[4], kind: "agy-login" };
    return undefined;
  },
  runCliCommand: runAgySubscriptionBootstrap,
  runtimeHomeShape: "private",
  hostReadinessOrder: 2,
  async prepareHostReadiness(agents, paths, resources) {
    const agent = agents[0];
    if (agent === undefined) return;
    const realm = await startAgySubscriptionRealm();
    resources.agyRealm = realm;
    const canonical = paths.forAgent(agent);
    await canonical.verify();
    const executable = await prepareEngineExecutable(agent.id, "agy");
    await verifyAgySubscriptionEnrollment(agent.id, executable.executablePath, canonical.runtimeHomePath, realm.busAddress);
    await executable.verify();
    await canonical.verify();
  },
  assertRuntimeLaunch() {},
  prepareRuntimeReadiness: (agent, bus) => prepareEngineReadiness(agent, agent.runtimeHomePath, bus),
  runtimeSandbox: () => ({}),
  runtimeSessionOptions({ agent, agyBusAddress, wakeEnvironmentContext }) {
    return {
      maxToolTurns: AGY_MAX_TOOL_TURNS,
      timeoutMs: 180_000,
      dbusSessionBusAddress: agyBusAddress,
      onTurnUsage: (usage, outcome) => recordTurnUsage(resolveTurnUsageLedgerPath(), { agent: agent.id, wake: wakeEnvironmentContext.current ?? "wake", engine: "agy", usage, outcome })
    };
  },
  runtimeToolName: (name) => name,
  mountedToolNamingRule: bareMountedToolNamingRule,
  runtimeHarnessToolNames: () => undefined
};
