import { readCodexRolloutRequests, type CodexRequestUsage } from "./codexRolloutUsage.js";
import { TURN_USAGE_MAX_IDENTIFIER_CHARS } from "../../runtime/turnUsageLedger.js";
import { TURN_REQUEST_LEDGER_VERSION, requestClockFields, recordLedgerLines, resolveTurnRequestLedgerPath } from "../../runtime/turnRequestLedger.js";

export type TurnRequestEntry = Readonly<{
  agent: string;
  wake: string;
  /** The Codex thread whose rollout these rows were read from. */
  thread: string;
  requests: readonly CodexRequestUsage[];
  at?: string;
}>;

const bounded = (value: string): string => [...value].slice(0, TURN_USAGE_MAX_IDENTIFIER_CHARS).join("");

/**
 * One line per model request.
 *
 * `fresh_input` is `input − cached_input`, the split the whole exercise exists
 * to see. It is derived from exactly the relationship Daimon already validates
 * (`cached_input_tokens` is a subset of `input_tokens`, asserted by Codex's own
 * reconciled totals and re-checked when the block is decoded). `cache_write` is
 * emitted raw and never subtracted, because whether Codex counts a cache write
 * inside `input_tokens` has not been verified — a reader that needs that answer
 * has the raw number to work from instead of a guess baked into the row.
 */
export const renderTurnRequestLines = (entry: TurnRequestEntry): string => {
  const at = entry.at ?? new Date().toISOString();
  const requests = entry.requests.length;
  return entry.requests.map((request) => `${JSON.stringify({
    v: TURN_REQUEST_LEDGER_VERSION,
    agent: bounded(entry.agent),
    wake: bounded(entry.wake),
    engine: "codex",
    at,
    thread: bounded(entry.thread),
    request: request.index,
    requests,
    input: request.input,
    cached_input: request.cachedInput,
    fresh_input: request.input - request.cachedInput,
    cache_write: request.cacheWrite,
    output: request.output,
    reasoning: request.reasoning,
    total: request.total,
    ...requestClockFields(request)
  })}\n`).join("");
};

/**
 * Advisory. Never rejects, and never writes an empty wake.
 *
 * A wake whose rollout was absent, unreadable, or undecodable contributes no
 * rows at all rather than a zero row — the same invariant the usage ledger
 * holds, for the same reason: a fabricated zero is byte-identical to a measured
 * one, and this stream exists to be believed.
 */
export const recordTurnRequests = async (file: string, entry: TurnRequestEntry): Promise<boolean> => {
  if (entry.requests.length === 0) return false;
  try {
    return await recordLedgerLines(file, renderTurnRequestLines(entry));
  } catch {
    /* advisory: instrumentation never fails a wake that published */
    return false;
  }
};

/**
 * The whole instrumentation path for one Codex wake: find that thread's
 * rollout, decode its per-request usage, append it. Never throws.
 *
 * A wake that produced no rows says so on stderr exactly once. Silence would
 * make a permanently blind instrument indistinguishable from a working one —
 * `--ephemeral`, a relocated `CODEX_HOME`, or a Codex version that renamed the
 * usage frame all end here, and each is worth one line rather than a
 * quietly-empty file nobody questions.
 */
export const recordCodexTurnRequests = async (input: Readonly<{
  agent: string;
  wake: string;
  codexHome: string;
  threadId: string;
  file?: string;
}>): Promise<boolean> => {
  try {
    const requests = await readCodexRolloutRequests(input.codexHome, input.threadId);
    const written = await recordTurnRequests(input.file ?? resolveTurnRequestLedgerPath(), {
      agent: input.agent,
      wake: input.wake,
      thread: input.threadId,
      requests
    });
    if (!written) {
      console.error(`daimon: no per-request usage recorded for codex thread ${input.threadId} (${requests.length === 0 ? "no decodable rollout usage" : "ledger append failed"})`);
    }
    return written;
  } catch (error) {
    console.error(`daimon: per-request usage instrumentation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
  }
};
