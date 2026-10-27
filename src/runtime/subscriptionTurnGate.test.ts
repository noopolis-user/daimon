import assert from "node:assert/strict";
import test from "node:test";
import { createSubscriptionTurnGate } from "./subscriptionTurnGate.js";

const latch = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

test("account owner bounds queue, cancels pending work, and lets the active turn finish on close", async () => {
  const gate = createSubscriptionTurnGate({ maxQueued: 2 });
  const active = latch();
  const first = gate.run(() => active.promise);
  const abort = new AbortController();
  const second = gate.run(async () => assert.fail("aborted operation ran"), abort.signal);
  const third = gate.run(async () => assert.fail("closed operation ran"));
  await assert.rejects(gate.run(async () => undefined), /queue is full/);
  abort.abort();
  await assert.rejects(second, /wait aborted/);
  const closed = gate.close();
  await assert.rejects(third, /authority is stopped/);
  active.release();
  await Promise.all([first, closed]);
  await assert.rejects(gate.run(async () => undefined), /authority is stopped/);
});

test("account wait timeout does not start the queued operation or disturb its successor", async () => {
  const gate = createSubscriptionTurnGate({ maxWaitMs: 10 });
  const active = latch();
  const first = gate.run(() => active.promise);
  await assert.rejects(gate.run(async () => assert.fail("timed out operation ran")), /wait exceeded/);
  const third = gate.run(async () => "successor");
  active.release();
  assert.equal(await third, "successor");
  await first;
  await gate.close();
});

test("owner liveness is checked again after waiting", async () => {
  let live = true;
  const gate = createSubscriptionTurnGate({ assertLive: () => { if (!live) throw new Error("owner died"); } });
  const active = latch();
  const first = gate.run(() => active.promise);
  const second = gate.run(async () => assert.fail("dead owner operation ran"));
  live = false;
  active.release();
  await assert.rejects(second, /owner died/);
  await first;
  await gate.close();
});
