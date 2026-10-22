import type { GrokBrokerModel } from "./grokBrokerModelPolicy.js";
import { TURN_USAGE_MAX_IDENTIFIER_CHARS } from "../../../runtime/turnUsageLedger.js";
import { TURN_REQUEST_LEDGER_VERSION, requestClockFields, recordLedgerLines } from "../../../runtime/turnRequestLedger.js";

const bounded = (value: string): string => [...value].slice(0, TURN_USAGE_MAX_IDENTIFIER_CHARS).join("");

/** One Grok broker model request: usage from the worker stream, timing from the proxy. */
/**
 * `usageSource`: `stream` (the worker's own per-request frame), `upstream`
 * (the provider response the proxy saw), or `estimated` (no valid usage; the
 * proxy's conservative charge, see `grokBrokerTurnMeter.ts`).
 */
/**
 * `toolCalls` are the tool-call names that request's response carried, as the
 * proxy read them (`grokBrokerTurnMeter.ts`): names only, bounded, `[]` for a
 * response that called nothing, and absent when no response could be decoded.
 */
export type GrokTurnRequest = Readonly<{ index: number; input: number; cacheRead: number; cacheWrite: number; output: number; total: number; startedAt?: string; endedAt?: string; usageSource?: "stream" | "upstream" | "estimated"; toolCalls?: readonly string[] }>;
/**
 * `requestCount` is the turn's admitted request count when it exceeds the rows:
 * a killed turn's in-flight request was sent upstream but never reported usage,
 * so it has no row yet still counts in every row's `requests`.
 */
export type GrokTurnRequestEntry = Readonly<{ agent: string; wake: string; turn: string; session?: string; model: GrokBrokerModel; requests: readonly GrokTurnRequest[]; requestCount?: number; at?: string }>;

/**
 * Grok rows share the Codex row's field meaning: `input` is the whole prompt
 * side the request replayed (`input_tokens + cache_read`), `cached_input` the
 * cache read, `fresh_input` the uncached remainder. Grok does not separate
 * reasoning tokens, so `reasoning` is absent rather than zero. `turn` is the
 * broker idempotency key and `thread` the Grok session id when the stream
 * named one.
 *
 * `tool_calls` is what a turn's rows could not say before: whether the model
 * ever *tried* to call anything. Two live turns ended with correctly mounted
 * tools and no visible attempt, and the rows recorded timings and tokens only,
 * so the question could not be answered after the fact. It is names only —
 * never arguments, never message content, never a bearer — bounded, `[]` for a
 * response that called nothing, and absent for a response that could not be
 * decoded, because a fabricated empty list is byte-identical to a measured one.
 *
 * It is an additive field inside the unchanged
 * `noopolis.daimon.turn-requests.v1` row, deliberately without a version bump:
 * Spawnfile's usage reader (`spawnfile/src/runtime/usageLedger.ts`) drops every
 * line whose `v` it does not recognise while ignoring fields it does not know,
 * and Paideia only relocates this stream's path
 * (`DAIMON_TURN_REQUESTS_LEDGER_PATH`). A bump is what would blind them; a new
 * field is not.
 */
export const renderGrokTurnRequestLines = (entry: GrokTurnRequestEntry): string => {
  const at = entry.at ?? new Date().toISOString();
  return entry.requests.map((request) => `${JSON.stringify({
    v: TURN_REQUEST_LEDGER_VERSION,
    agent: bounded(entry.agent),
    wake: bounded(entry.wake),
    engine: "grok",
    at,
    turn: entry.turn,
    ...(entry.session === undefined ? {} : { thread: bounded(entry.session) }),
    model: entry.model,
    request: request.index,
    requests: Math.max(entry.requests.length, entry.requestCount ?? 0),
    input: request.input + request.cacheRead,
    cached_input: request.cacheRead,
    fresh_input: request.input,
    cache_write: request.cacheWrite,
    output: request.output,
    total: request.total,
    ...(request.usageSource === undefined ? {} : { usage_source: request.usageSource }),
    ...(request.toolCalls === undefined ? {} : { tool_calls: request.toolCalls }),
    ...requestClockFields(request)
  })}\n`).join("");
};

/** Advisory and never rejects, like {@link recordTurnRequests}; an empty turn writes nothing. */
export const recordGrokTurnRequests = async (file: string, entry: GrokTurnRequestEntry): Promise<boolean> => {
  if (entry.requests.length === 0) return false;
  try { return await recordLedgerLines(file, renderGrokTurnRequestLines(entry)); } catch { return false; }
};
