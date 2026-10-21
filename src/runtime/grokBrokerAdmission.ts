import type { ServerResponse } from "node:http";

import type { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";

type Admission = ReturnType<GrokBrokerTurnMeter["admit"]>;
/** Admitted (index and upstream signal) or refused by a limit: never `busy`. */
export type GrokBrokerSettledAdmission = Exclude<Admission, Readonly<{ busy: true }>>;

/**
 * Admits one request to a meter's single upstream lane, waiting its turn
 * instead of refusing it while another request is in flight.
 *
 * A refusal there is not a spend control — the waiting request is admitted
 * afresh, every limit re-checked against the total the in-flight answer just
 * reported into — but it is fatal to the turn: the worker runs with
 * `max_retries = 0`, so one 429 `turn request in flight` ends its turn. That is
 * what killed Grok training pilots 52–54 (`grokBrokerTurnMeter.ts`): the proxy
 * received two copies of one logically sequential request and refused the copy
 * the worker was reading.
 *
 * - `gone`: the client closed its connection while waiting. The request is
 *   never admitted, counted or forwarded; nobody is left to read an answer.
 * - `revoked`: `current()` turned false while waiting (the turn ended and was
 *   revoked). The caller refuses it exactly as a request that arrived late.
 */
export async function admitWhenIdle(
  meter: GrokBrokerTurnMeter, response: ServerResponse, options: Readonly<{ keepFinal?: boolean }>, current: () => boolean = () => true
): Promise<GrokBrokerSettledAdmission | "gone" | "revoked"> {
  let admission = meter.admit(options);
  if (!("busy" in admission)) return admission;
  let gone = false, onClose!: () => void;
  const closed = new Promise<void>((resolve) => { onClose = () => { gone = true; resolve(); }; });
  response.once("close", onClose);
  try {
    while ("busy" in admission) {
      await Promise.race([meter.whenIdle(), closed]);
      if (gone || response.destroyed) return "gone";
      if (!current()) return "revoked";
      admission = meter.admit(options);
    }
    return admission;
  } finally { response.off("close", onClose); }
}
