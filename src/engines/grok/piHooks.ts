import type { PiEngineHooks } from "../piHooks.js";
import { asGrokAuthenticationRejected, GrokSubscriptionAuthenticationRejectedError } from "./broker/grokAuthenticationError.js";

const brokerOnly = (): never => { throw new Error("Grok runs only through the engine broker"); };

/** Every Grok turn is a broker turn; Daimon never spawns Grok with an agent-held login. */
export const grokPiHooks: PiEngineHooks = {
  environmentIntent: () => ({}),
  environmentVariables: () => ({}),
  spawnPlan: brokerOnly,
  registerMcp: brokerOnly,
  brokerTurn: (options) => options.grokBrokerTurn ?? brokerOnly,
  childReadOptions: brokerOnly,
  decodeOutput: brokerOnly,
  authenticationError: (failure, cleanupFailure) => asGrokAuthenticationRejected(failure) === undefined
    ? undefined : new GrokSubscriptionAuthenticationRejectedError(cleanupFailure),
  defaultRunOptions: () => ({ engine: "grok" })
};
