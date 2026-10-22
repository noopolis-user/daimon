import { GROK_BROKER_MODELS } from "./broker/grokWorkerContract.js";
import { ENGINE_BROKER_LIMIT_REASONS, type EngineBrokerLimitReason } from "./broker/engineBrokerTurnAccounting.js";
import type { GrokBrokerModel } from "./broker/grokBrokerModelPolicy.js";

/** Optional broker metadata remains readable on every historical engine row. */
export type BrokerTurnUsageFields = Readonly<{
  /**
   * Broker rows only. `turn` is the idempotency key readers dedupe on (the
   * broker turn id, a sha256 hex); `limitReason` and `model` come from the
   * closed broker vocabularies and are dropped rather than written through
   * when they are not members.
   */
  turn?: string;
  limitReason?: EngineBrokerLimitReason;
  model?: GrokBrokerModel;
  /** Broker rows only: how many of the turn's requests were charged an estimate because their response carried no valid usage. */
  estimatedRequests?: number;
}>;

export const brokerFields = (entry: BrokerTurnUsageFields): Record<string, string | number> => ({
  ...(entry.turn !== undefined && /^[a-f0-9]{64}$/u.test(entry.turn) ? { turn: entry.turn } : {}),
  ...(entry.limitReason !== undefined && ENGINE_BROKER_LIMIT_REASONS.includes(entry.limitReason) ? { limit_reason: entry.limitReason } : {}),
  ...(entry.model !== undefined && (GROK_BROKER_MODELS as readonly string[]).includes(entry.model) ? { model: entry.model } : {}),
  ...(entry.estimatedRequests !== undefined && Number.isSafeInteger(entry.estimatedRequests) && entry.estimatedRequests > 0 ? { estimated_requests: entry.estimatedRequests } : {})
});
