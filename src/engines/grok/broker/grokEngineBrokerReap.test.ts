import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { awaitGrokWorkerIdentityEmpty, grokWorkerIdentityEmpty } from "./grokEngineBrokerTurnEnd.js";

test("clock cleanup cannot infer an empty worker identity from an unreadable proc root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await grokWorkerIdentityEmpty(2200, root, true), true);
  assert.equal(await grokWorkerIdentityEmpty(2200, path.join(root, "missing"), true), false);
});

test("worker reap stability measures elapsed time while the wall clock is frozen", async (t) => {
  const wall = t.mock.method(Date, "now", () => 0);
  let deadline: NodeJS.Timeout | undefined;
  const reaped = awaitGrokWorkerIdentityEmpty(2200, 100, async () => true, 1, 20);
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("worker reap followed the frozen wall clock")), 500);
    });
    assert.equal(await Promise.race([reaped, expired]), true);
  } finally {
    clearTimeout(deadline);
    wall.mock.restore();
    await reaped;
  }
});
