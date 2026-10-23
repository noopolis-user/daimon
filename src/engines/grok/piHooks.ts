import { ENGINE_DESCRIPTORS } from "../descriptors.js";
import type { PiEngineHooks } from "../piHooks.js";
import { GROK_STRICT_SANDBOX_PROFILE, renderGrokSandboxArgs } from "./piArgs.js";
import { decodeGrokHeadlessResult } from "./grokHeadlessResult.js";
import { registerGrokHomeMcpServer } from "./grokHomeMcpRegistration.js";
import { asGrokAuthenticationRejected, classifyGrokAuthenticationDiagnostic, GrokSubscriptionAuthenticationRejectedError } from "./broker/grokAuthenticationError.js";

export const grokPiHooks: PiEngineHooks = {
  environmentIntent: () => ({}),
  environmentVariables: ({ engineHomePath }) => engineHomePath === undefined ? {} : { [ENGINE_DESCRIPTORS.grok.homeEnvironment]: engineHomePath },
  spawnPlan: (options, prompt, input) => ({ args: [
    ...renderGrokSandboxArgs(options.commandArgs, options.grokSandboxProfile ?? GROK_STRICT_SANDBOX_PROFILE),
    "--always-approve", "--no-subagents", "--single", prompt, "--no-memory", "--disable-web-search", "--cwd", input.cwd,
    "--output-format", "streaming-messages-json"
  ] }),
  registerMcp: async ({ options, endpoint }) => {
    await options.verifyExecutable?.();
    return registerGrokHomeMcpServer({ engineHomePath: options.engineHomePath, endpoint,
      ...(options.verifyGrokSandbox !== undefined ? { verify: options.verifyGrokSandbox } : {}) });
  },
  brokerTurn: (options) => options.grokBrokerTurn === undefined ? undefined
    : (prompt, endpoint, signal) => options.grokBrokerTurn!(prompt, endpoint, signal),
  childReadOptions: () => ({ failureClassifier: classifyGrokAuthenticationDiagnostic, retainStdoutTail: true }),
  decodeOutput: (output) => ({ text: decodeGrokHeadlessResult(output) }),
  authenticationError: (failure, cleanupFailure) => asGrokAuthenticationRejected(failure) === undefined
    ? undefined : new GrokSubscriptionAuthenticationRejectedError(cleanupFailure),
  defaultRunOptions: () => ({ engine: "grok" })
};
