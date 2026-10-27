import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { waitForSubscriptionLeaseReady } from "./subscriptionLeaseReady.js";

test("lease handshake accepts fragmented pipe reads and removes its listeners", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null, signalCode: null });
  const ready = waitForSubscriptionLeaseReady(child as unknown as ChildProcess);
  child.stdout.write("re"); child.stdout.write("ad"); child.stdout.write("y\n");
  await ready;
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("lease handshake rejects a malformed, overlong, closed or silent response", async () => {
  for (const value of ["invalid", "ready\nextra", "close", "silent"]) {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null, signalCode: null });
    const ready = waitForSubscriptionLeaseReady(child as unknown as ChildProcess, 10);
    if (value === "close") child.emit("close");
    else if (value !== "silent") child.stdout.write(value);
    await assert.rejects(ready, /subscription lease/);
  }
});
