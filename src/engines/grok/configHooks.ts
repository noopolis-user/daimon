import { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS } from "./broker/grokWorkerContract.js";
import type { OrganizationRuntimeEngineIntent } from "../../runtime/organizationRuntime.js";
import type { ConfigEngineHooks, EngineConfigRecord, EngineConfigParsers } from "../configHooks.js";

export const grokConfigHooks: ConfigEngineHooks = {
  parseConfig(input, label, parsers) {
    const allowed = ["kind", "model", "reasoningEffort"];
    const extras = Object.keys(input).filter((key) => !allowed.includes(key));
    if (extras.includes("codexSandbox")) throw new TypeError(`${label}.codexSandbox is codex-only; the Grok worker sandbox is Daimon-owned`);
    if (extras.length > 0) throw new TypeError(`${label} must contain exactly ${allowed.join(", ")}`);
    return grokEngine(input, label, parsers);
  }
};

/**
 * A Grok model is declared explicitly or not at all: both members from the
 * closed broker lists, never one of them with the other inherited. Omitting
 * both keeps a config parseable by pre-declaration producers; the brokered
 * paths that need a model (`grokBrokerProjection.ts`, `service.json` v2)
 * require it there instead of defaulting it here.
 */
function grokEngine(input: EngineConfigRecord, label: string, { string }: EngineConfigParsers): OrganizationRuntimeEngineIntent {
  if ((input.model === undefined) !== (input.reasoningEffort === undefined)) throw new TypeError(`${label}.model and ${label}.reasoningEffort must be declared together for grok`);
  if (input.model === undefined) return { kind: "grok" };
  const model = string(input.model, `${label}.model`), effort = string(input.reasoningEffort, `${label}.reasoningEffort`);
  if (!(GROK_BROKER_MODELS as readonly string[]).includes(model)) throw new TypeError(`${label}.model must be one of ${GROK_BROKER_MODELS.join(", ")}`);
  if (!(GROK_BROKER_REASONING_EFFORTS as readonly string[]).includes(effort)) throw new TypeError(`${label}.reasoningEffort must be one of ${GROK_BROKER_REASONING_EFFORTS.join(", ")}`);
  return { kind: "grok", model, reasoningEffort: effort };
}

