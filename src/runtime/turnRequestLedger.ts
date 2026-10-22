import path from "node:path";
import { constants } from "node:fs";
import { open, rename, stat } from "node:fs/promises";

import { TURN_USAGE_LEDGER, TURN_USAGE_MAX_IDENTIFIER_CHARS, TURN_USAGE_ROTATE_BYTES } from "./turnUsageLedger.js";

/**
 * Per-model-request token accounting, written *beside* the per-wake usage
 * ledger and never inside it.
 *
 * `turnUsageLedger.ts` records one aggregate row per wake. Production measured
 * 55 wakes at 14,890,263 input tokens against 159,726 output — output is 1.06%
 * of the spend — with context per model request flat at 23–32k regardless of
 * how many requests a wake made. That is the signature of a fixed prefix
 * replayed once per request rather than of a conversation that grows, but the
 * aggregate row cannot tell the two apart, and every optimisation worth doing
 * next depends on which one it is. This file is what tells them apart.
 *
 * It is a separate stream, not a wider row, for one specific reason. Spawnfile's
 * reader (`spawnfile/src/runtime/usageLedger.ts`) rejects any line whose `v` is
 * not `noopolis.daimon.turn-usage.v1` and returns `null` for the whole line, so
 * a version bump on the existing ledger would make an unreleased Spawnfile drop
 * every row it can read today. Nothing here changes the shape, version, path, or
 * field list of that ledger; a reader that knows nothing about this file keeps
 * working byte for byte.
 */
export const TURN_REQUEST_LEDGER_VERSION = "noopolis.daimon.turn-requests.v1" as const;

/**
 * Default location: the directory Spawnfile already provisions for the usage
 * ledger, under its own filename. No new mount, no new provisioning step.
 */
export const TURN_REQUEST_LEDGER = {
  version: TURN_REQUEST_LEDGER_VERSION,
  directoryPath: TURN_USAGE_LEDGER.directoryPath,
  filePath: `${TURN_USAGE_LEDGER.directoryPath}/requests.jsonl`,
  rotatedFilePath: `${TURN_USAGE_LEDGER.directoryPath}/requests.jsonl.1`,
  fileMode: TURN_USAGE_LEDGER.fileMode
} as const;

/**
 * `DAIMON_TURN_REQUESTS_LEDGER_PATH` relocates the stream, exactly as
 * `DAIMON_TURN_USAGE_LEDGER_PATH` relocates the ledger it sits beside. A
 * relative or empty value is ignored rather than honoured: a ledger written to
 * a process-relative path is a ledger nobody can find again.
 */
export const TURN_REQUEST_LEDGER_PATH_ENV = "DAIMON_TURN_REQUESTS_LEDGER_PATH" as const;

export const resolveTurnRequestLedgerPath = (environment: NodeJS.ProcessEnv = process.env): string => {
  const override = environment[TURN_REQUEST_LEDGER_PATH_ENV]?.trim();
  return override !== undefined && override.startsWith("/") ? override : TURN_REQUEST_LEDGER.filePath;
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/u;
/** Per-request `started_at`/`ended_at`, each only when it was measured; `at` stays the append time. */
export const requestClockFields = (request: Readonly<{ startedAt?: string; endedAt?: string }>): Record<string, string> => ({
  ...(request.startedAt !== undefined && TIMESTAMP.test(request.startedAt) ? { started_at: request.startedAt } : {}),
  ...(request.endedAt !== undefined && TIMESTAMP.test(request.endedAt) ? { ended_at: request.endedAt } : {})
});

/**
 * Append already-rendered, newline-terminated ledger lines in one write, with the
 * same rotation and file mode as both ledgers. Advisory: never rejects. The
 * broker uses it to append the exact bytes it sealed into a turn record.
 */
const ledgerWrites = new Map<string, Promise<boolean>>();

export const recordLedgerLines = async (file: string, lines: string): Promise<boolean> => {
  if (lines.length === 0) return false;
  const key = path.resolve(file);
  const previous = ledgerWrites.get(key) ?? Promise.resolve(true);
  const pending = previous.then(async () => {
    try { await rotate(key); await appendLines(key, lines); return true; } catch { return false; }
  });
  ledgerWrites.set(key, pending);
  try { return await pending; } finally {
    if (ledgerWrites.get(key) === pending) ledgerWrites.delete(key);
  }
};

const rotate = async (file: string): Promise<void> => {
  let size: number;
  try { size = (await stat(file)).size; } catch { return; }
  if (size >= TURN_USAGE_ROTATE_BYTES) await rename(file, `${file}.1`);
};

/** Rotation and all writes are serialized per canonical path in this broker process.
 * The realm lease excludes another broker. Independent paths remain concurrent.
 */
const appendLines = async (file: string, lines: string): Promise<void> => {
  const bytes = Buffer.from(lines, "utf8");
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, TURN_REQUEST_LEDGER.fileMode);
  try {
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length);
    if (bytesWritten !== bytes.length) throw new Error("turn request ledger append was torn");
  } finally { await handle.close(); }
};


export { renderTurnRequestLines, recordTurnRequests, recordCodexTurnRequests, type TurnRequestEntry } from "../engines/codex/turnRequestLedger.js";
export { renderGrokTurnRequestLines, recordGrokTurnRequests, type GrokTurnRequest, type GrokTurnRequestEntry } from "../engines/grok/broker/turnRequestLedger.js";
