import { ENGINE_DESCRIPTORS } from "../descriptors.js";
import type { PiEngineHooks } from "../piHooks.js";
import { resolveCodexPiProvider } from "./piModel.js";
import { createCodexOutputRetention } from "./piOutput.js";
import { renderCodexArgs } from "./piArgs.js";
import { decodeCodexTurn } from "./piTurnMetering.js";
import { codexGatewayFromEnvironment, DAIMON_GATEWAY_KEY_ENV } from "./gatewayProvider.js";

export const codexPiHooks: PiEngineHooks = {
  resolvePiProvider: resolveCodexPiProvider,
  createOutputRetention: createCodexOutputRetention,
  environmentIntent: () => ({}),
  environmentVariables: ({ engineHomePath }) => {
    if (engineHomePath === undefined) return {};
    const gateway = codexGatewayFromEnvironment();
    return { [ENGINE_DESCRIPTORS.codex.homeEnvironment]: engineHomePath, ...(gateway === undefined ? {} : { [DAIMON_GATEWAY_KEY_ENV]: gateway.key }) };
  },
  spawnPlan: (options, prompt, input, endpoint) => ({ args: renderCodexArgs(options, input.cwd, endpoint), stdin: prompt }),
  registerMcp: async () => undefined,
  brokerTurn: () => undefined,
  childReadOptions: (options) => ({
    retainNdjson: "codex",
    timeoutErrorMessage: options.timeoutMs === undefined ? undefined : `Codex wake exceeded its ${options.timeoutMs}ms per-wake wall-clock bound`,
    codexTokenCeiling: options.codexTokenCeiling
  }),
  decodeOutput: decodeCodexTurn,
  authenticationError: () => undefined,
  defaultRunOptions: () => ({ engine: "codex" })
};
