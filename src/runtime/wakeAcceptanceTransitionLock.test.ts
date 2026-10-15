import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WakeAcceptanceStore, WakeExecutionClaimLostError, WakeTransitionLockContentionError } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";
import { waitForClaimTransitionLock } from "./wakeAcceptanceClaimDiagnostics.js";
import { WakeTransitionLockBlockedError } from "./wakeAcceptanceProcessIdentity.js";

const identity = { pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 };
const options = { processIdentity: async () => identity, ownerLiveness: async () => true };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const expectedClaim = { acceptance_id: randomUUID(), owner_id: randomUUID(), generation: randomUUID(), expires_at: "2099-01-01T00:00:00.000Z" };
const acquiredLock = { owner_id: expectedClaim.owner_id, generation: randomUUID(), ...identity };

for (const wakeAt of [250, 301]) {
  test(`no acquisition starts when a retry sleep wakes at ${wakeAt} ms`, async () => {
    let now = 0;
    const starts: number[] = [];
    await assert.rejects(waitForClaimTransitionLock(async () => {
      starts.push(now);
      return starts.length === 1 ? undefined : acquiredLock;
    }, async () => acquiredLock, expectedClaim.acceptance_id, expectedClaim, "renew", {
      now: () => now, sleep: async () => { now = wakeAt; }
    }), WakeTransitionLockContentionError);
    assert.deepEqual(starts, [0]);
  });
}

test("the deadline is checked before even the first acquisition", async () => {
  let clockReads = 0; let attempts = 0;
  await assert.rejects(waitForClaimTransitionLock(async () => { attempts++; return acquiredLock; }, async () => undefined,
    expectedClaim.acceptance_id, expectedClaim, "renew", {
      now: () => clockReads++ === 0 ? 0 : 250,
      sleep: async () => { assert.fail("must not sleep after deadline"); }
    }), WakeTransitionLockContentionError);
  assert.equal(attempts, 0);
});

test("retry sleep is capped to the remaining budget", async () => {
  let now = 0;
  const starts: number[] = []; const sleeps: number[] = [];
  await assert.rejects(waitForClaimTransitionLock(async () => { starts.push(now); now = 247; return undefined; }, async () => acquiredLock,
    expectedClaim.acceptance_id, expectedClaim, "renew", {
      now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }
    }), WakeTransitionLockContentionError);
  assert.deepEqual(starts, [0]);
  assert.deepEqual(sleeps, [3]);
  assert.equal(now, 250);
});

test("a failed acquisition that finishes late neither sleeps nor retries", async () => {
  let now = 0; let attempts = 0;
  await assert.rejects(waitForClaimTransitionLock(async () => { attempts++; now = 363; return undefined; }, async () => acquiredLock,
    expectedClaim.acceptance_id, expectedClaim, "renew", {
      now: () => now, sleep: async () => { assert.fail("must not sleep after deadline"); }
    }), WakeTransitionLockContentionError);
  assert.equal(attempts, 1);
});

test("an acquisition admitted before the deadline may complete late for caller revalidation", async () => {
  let now = 0;
  const lock = await waitForClaimTransitionLock(async () => { now = 363; return acquiredLock; }, async () => undefined,
    expectedClaim.acceptance_id, expectedClaim, "renew", {
      now: () => now, sleep: async () => { assert.fail("acquired lock must not be retried"); }
    });
  assert.equal(lock, acquiredLock);
});

async function fixture(ownerLiveness = options.ownerLiveness, claimTransitionLockTimingForTest?: Parameters<typeof waitForClaimTransitionLock>[5]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-claim-lock-")); await chmod(root, 0o700);
  const testOptions = { ...options, ownerLiveness, claimTransitionLockTimingForTest };
  const store = await WakeAcceptanceStore.open(root, testOptions);
  const { record } = await store.accept(parseWakeAcceptanceRequest({ token: undefined, agent_id: "alpha", delivery_id: "D1", event: { version: "noopolis.daimon.wake.v2", kind: "message", text: "work", occurred_at: "2026-10-15T05:48:17.282Z" } }));
  const result = await store.acquireClaim(record.acceptance_id, randomUUID(), [record.acceptance_id], randomUUID());
  if (result.state !== "acquired") throw new Error("claim missing");
  return { root, store, record, claim: result.claim, claimPath: path.join(root, `${hash("alpha")}.agent-claim`), lockPath: path.join(root, `${hash("alpha\u0000D1")}.transition-lock`), cleanup: async () => { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("a claimed transition waits for a concurrent transition to release its lock", async () => {
  let contended!: () => void;
  const contention = new Promise<void>((resolve) => { contended = resolve; });
  const f = await fixture(async () => { contended(); return true; });
  let reached!: () => void; let resume!: () => void;
  const locked = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const first = await WakeAcceptanceStore.open(f.root, { ...options, afterFinalLockAssertion: async () => { reached(); await held; } });
  let writing: Promise<unknown> | undefined;
  try {
    writing = first.transitionClaimed(f.record.acceptance_id, f.claim, "running");
    await locked;
    const competing = f.store.transitionClaimed(f.record.acceptance_id, f.claim, "running");
    void competing.catch(() => undefined);
    await contention;
    // Keep the real lock contended across the first attempt, then release it.
    const timer = setTimeout(resume, 40);
    try { assert.equal((await competing).state, "running"); } finally { clearTimeout(timer); resume(); }
    await writing;
    assert.equal((await readdir(f.root)).some((file) => file.endsWith(".transition-lock")), false);
  } finally { resume(); await writing?.catch(() => undefined); await first.close(); await f.cleanup(); }
});

test("a missing claim reports the failed assertion before admission and releases its lock", async () => {
  const f = await fixture();
  try {
    await unlink(f.claimPath);
    await assert.rejects(f.store.transitionClaimed(f.record.acceptance_id, f.claim, "running"), (error: unknown) => {
      assert.ok(error instanceof WakeExecutionClaimLostError);
      assert.match(error.message, /step=transition:running:initial.*assertion=claim_missing/u);
      assert.match(error.message, new RegExp(f.claim.generation));
      return true;
    });
    assert.equal((await f.store.status(f.record.acceptance_id))?.state, "accepted");
    await assert.rejects(readFile(f.lockPath), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("a claim replaced during retry sleep is revalidated and rejected without writing", async () => {
  let now = 0; let sleeps = 0;
  const f = await fixture(options.ownerLiveness, { now: () => now, sleep: async (ms) => {
    sleeps++;
    await writeFile(f.claimPath, JSON.stringify(replacement));
    await unlink(f.lockPath);
    now += ms;
  } });
  const replacement = { ...f.claim, owner_id: randomUUID(), generation: randomUUID() };
  try {
    await writeFile(f.lockPath, JSON.stringify(acquiredLock), { mode: 0o600 });
    const before = await f.store.activity();
    await assert.rejects(f.store.transitionClaimed(f.record.acceptance_id, f.claim, "running"), (error: unknown) => {
      assert.ok(error instanceof WakeExecutionClaimLostError);
      assert.equal(error.detail?.assertion, "claim_owner_id");
      assert.deepEqual(error.detail?.current, replacement);
      assert.ok(error.detail?.lock);
      return true;
    });
    assert.equal(sleeps, 1);
    assert.deepEqual(await f.store.activity(), before);
    assert.deepEqual(JSON.parse(await readFile(f.claimPath, "utf8")), replacement);
    await assert.rejects(readFile(f.lockPath), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("a live orphan lock exhausts retries and names the lock identity", async () => {
  let checks = 0;
  const f = await fixture(async () => { checks++; return true; });
  const lock = { owner_id: randomUUID(), generation: randomUUID(), ...identity };
  try {
    await writeFile(f.lockPath, JSON.stringify(lock), { mode: 0o600 });
    await assert.rejects(f.store.transitionClaimed(f.record.acceptance_id, f.claim, "running"), (error: unknown) => {
      assert.ok(error instanceof WakeTransitionLockContentionError);
      assert.match(error.message, /step=transition:running.*assertion=transition_lock_contended/u);
      assert.match(error.message, new RegExp(lock.generation));
      return true;
    });
    assert.ok(checks <= 26);
    assert.equal((await f.store.status(f.record.acceptance_id))?.state, "accepted");
    assert.deepEqual(JSON.parse(await readFile(f.lockPath, "utf8")), lock);
  } finally { await f.cleanup(); }
});

test("an unknown namespace is diagnosed and never reclaimed or retried", async () => {
  let checks = 0;
  const f = await fixture(async () => { checks++; return false; });
  const lock = { owner_id: randomUUID(), generation: randomUUID(), ...identity, pid_namespace_ino: 2 };
  try {
    await writeFile(f.lockPath, JSON.stringify(lock), { mode: 0o600 });
    await assert.rejects(f.store.transitionClaimed(f.record.acceptance_id, f.claim, "running"), (error: unknown) => {
      assert.ok(error instanceof WakeTransitionLockBlockedError);
      assert.match(error.message, /step=acquire_transition_lock assertion=transition_lock_namespace/u);
      assert.deepEqual(error.detail?.current, lock);
      assert.deepEqual(error.detail?.expected, identity);
      return true;
    });
    assert.equal(checks, 0);
    assert.deepEqual(JSON.parse(await readFile(f.lockPath, "utf8")), lock);
  } finally { await f.cleanup(); }
});

test("a crashed owner's lock is reclaimed without changing the valid execution claim", async () => {
  const f = await fixture(async () => false);
  try {
    await writeFile(f.lockPath, JSON.stringify({ owner_id: randomUUID(), generation: randomUUID(), ...identity }), { mode: 0o600 });
    assert.equal((await f.store.transitionClaimed(f.record.acceptance_id, f.claim, "running")).claim_generation, f.claim.generation);
    assert.deepEqual(JSON.parse(await readFile(f.claimPath, "utf8")), f.claim);
    await assert.rejects(readFile(f.lockPath), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

for (const field of ["owner_id", "generation", "expires_at", "acceptance_id"] as const) {
  test(`a changed claim identifies ${field} and preserves the accepted record`, async () => {
    const f = await fixture();
    try {
      const current = { ...f.claim, [field]: field === "expires_at" ? new Date(Date.parse(f.claim.expires_at) + 1000).toISOString() : randomUUID() };
      if (field === "acceptance_id") current.acceptance_ids = [f.record.acceptance_id, current.acceptance_id];
      await writeFile(f.claimPath, JSON.stringify(current));
      await assert.rejects(f.store.transitionClaimed(f.record.acceptance_id, f.claim, "running"), (error: unknown) => {
        assert.ok(error instanceof WakeExecutionClaimLostError);
        assert.equal(error.detail?.assertion, `claim_${field}`);
        assert.deepEqual(error.detail?.expected, f.claim);
        assert.deepEqual(error.detail?.current, current);
        assert.ok(error.detail?.lock);
        return true;
      });
      assert.equal((await f.store.status(f.record.acceptance_id))?.state, "accepted");
    } finally { await f.cleanup(); }
  });
}
