import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { WakeExecutionClaim } from "./wakeAcceptanceStore.js";
import { WakeTransitionLockBlockedError, type TransitionLock } from "./wakeAcceptanceProcessIdentity.js";

type Identity = WakeExecutionClaim | TransitionLock | string | null;
export type WakeClaimFailure = Readonly<{ step: string; assertion: string; acceptance_id: string; expected: Identity; current: Identity; lock?: TransitionLock | null }>;
export class WakeExecutionClaimLostError extends Error {
  constructor(readonly detail?: WakeClaimFailure, cause?: unknown) {
    super(`wake execution claim was lost${detail === undefined ? "" : `: step=${detail.step} assertion=${detail.assertion} ${JSON.stringify({ ...detail, expected: diagnosticIdentity(detail.expected), current: diagnosticIdentity(detail.current) })}`}`, { cause });
    this.name = "WakeExecutionClaimLostError";
  }
}
export class WakeTransitionLockContentionError extends WakeExecutionClaimLostError {
  constructor(detail: WakeClaimFailure) { super(detail); this.name = "WakeTransitionLockContentionError"; }
}

type LockWaitTiming = Readonly<{ now: () => number; sleep: (ms: number) => Promise<void> }>;
const lockWaitTiming: LockWaitTiming = { now: () => performance.now(), sleep: async (ms) => { await delay(ms); } };
/**
 * Only an occupied lock is retried; claim mismatches and I/O failures are not.
 * The 250 ms budget bounds attempt starts and requested sleeps. Filesystem I/O
 * is not cancellable, so an admitted acquisition can finish after the deadline.
 * Keep that lock: callers revalidate the claim before writing and release the
 * lock in finally, so late acquisition cannot authorize a stale claim.
 */
export async function waitForClaimTransitionLock(acquire: () => Promise<TransitionLock | undefined>, read: () => Promise<TransitionLock | undefined>, acceptanceId: string, claim: WakeExecutionClaim, step: string, timing: LockWaitTiming = lockWaitTiming): Promise<TransitionLock> {
  const deadline = timing.now() + 250;
  for (let attempt = 0; ; attempt++) {
    if (attempt >= 26 || timing.now() >= deadline) {
      let current: TransitionLock | undefined;
      try { current = await read(); } catch (cause) { throw new WakeExecutionClaimLostError({ step, assertion: "transition_lock_read", acceptance_id: acceptanceId, expected: claim, current: null }, cause); }
      throw new WakeTransitionLockContentionError({ step, assertion: "transition_lock_contended", acceptance_id: acceptanceId, expected: claim, current: current ?? null, lock: current ?? null });
    }
    let lock: TransitionLock | undefined;
    try { lock = await acquire(); } catch (cause) {
      if (cause instanceof WakeTransitionLockBlockedError) throw cause;
      throw new WakeExecutionClaimLostError({ step, assertion: "transition_lock_acquire", acceptance_id: acceptanceId, expected: claim, current: null }, cause);
    }
    if (lock !== undefined) return lock;
    const remaining = deadline - timing.now();
    if (remaining > 0 && attempt < 25) await timing.sleep(Math.min(10, remaining));
  }
}

function diagnosticIdentity(value: Identity): Identity {
  if (value === null || typeof value === "string" || "pid" in value) return value;
  // Membership can contain 32 UUIDs. Keep both identities and the lock visible
  // through the host's 2 KiB diagnostic bound; the typed detail keeps membership.
  const { acceptance_ids: _members, ...identity } = value;
  return identity;
}

/** Read errors retain their errno as cause; no record/event/credential data enters diagnostics. */
export async function readExpectedClaim(read: () => Promise<WakeExecutionClaim>, acceptanceId: string, expected: WakeExecutionClaim, step: string, now: () => number, lock?: TransitionLock): Promise<WakeExecutionClaim> {
  let current: WakeExecutionClaim;
  try { current = await read(); } catch (cause) {
    const assertion = (cause as NodeJS.ErrnoException)?.code === "ENOENT" ? "claim_missing" : "claim_read";
    throw new WakeExecutionClaimLostError({ step, assertion, acceptance_id: acceptanceId, expected, current: null, ...(lock === undefined ? {} : { lock }) }, cause);
  }
  const assertion = !(current.acceptance_id === acceptanceId || current.acceptance_ids?.includes(acceptanceId)) ? "claim_membership"
    : current.acceptance_id !== expected.acceptance_id ? "claim_acceptance_id"
      : current.owner_id !== expected.owner_id ? "claim_owner_id"
        : current.generation !== expected.generation ? "claim_generation"
          : current.expires_at !== expected.expires_at ? "claim_expires_at"
            : Date.parse(current.expires_at) <= now() ? "claim_expired" : undefined;
  if (assertion !== undefined) throw new WakeExecutionClaimLostError({ step, assertion, acceptance_id: acceptanceId, expected, current, ...(lock === undefined ? {} : { lock }) });
  return current;
}
