import type { AgyTurnUsage } from "../engines/agy/agyHeadlessResult.js";
import { cliChildFailureReason } from "./cliChildOutput.js";
import type { CodexTurnUsage } from "../engines/codex/codexHeadlessResult.js";
import type { TurnUsageOutcome } from "../runtime/turnUsageLedger.js";

export { createCliTurnMeter, decodeCodexTurn, type CliTurnMeter } from "../engines/codex/piTurnMetering.js";

/** The failed row's marker, named by the bound that actually fired. */
export const failedTurnOutcome = (failure: unknown): TurnUsageOutcome =>
  ({ status: "failed", reason: cliChildFailureReason(failure) ?? "unknown" });

/**
 * Advisory: metering never fails, delays, or rewrites the wake it describes —
 * the same ordering rule the Grok engine broker states in
 * `finishBrokerTurnWithUsage`.
 */
export const publishTurnUsage = async (
  sink: ((usage: AgyTurnUsage | CodexTurnUsage, outcome: TurnUsageOutcome) => Promise<void>) | undefined,
  usage: AgyTurnUsage | CodexTurnUsage | undefined,
  outcome: TurnUsageOutcome
): Promise<void> => {
  if (usage === undefined) return;
  try { await sink?.(usage, outcome).catch(() => undefined); } catch { /* advisory */ }
};

/**
 * Advisory per-request instrumentation, under the same ordering rule as
 * {@link publishTurnUsage}: it never fails, delays, or rewrites the wake it
 * describes.
 *
 * No thread id means Codex never announced one — an engine that is not Codex,
 * a child killed before its first frame, or a future stream that renamed the
 * event. Nothing is written in that case, because the alternative is guessing
 * which rollout on disk belongs to this wake.
 */
export const publishTurnRequests = async (
  sink: ((threadId: string) => Promise<void>) | undefined,
  threadId: string | undefined
): Promise<void> => {
  if (threadId === undefined) return;
  try { await sink?.(threadId).catch(() => undefined); } catch { /* advisory */ }
};
