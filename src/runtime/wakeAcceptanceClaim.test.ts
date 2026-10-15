import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WakeAcceptanceStore, WakeExecutionClaimLostError } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";

for (const takeover of [false, true]) {
  test(`a batch fails closed with an ${takeover ? "expired and replaced" : "expired"} claim`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daimon-batch-claim-")); await chmod(root, 0o700);
    let now = Date.now();
    const store = await WakeAcceptanceStore.open(root, {
      nowForTest: () => now, claimTtlMs: 240_000,
      processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }),
      ownerLiveness: async () => true
    });
    try {
      const records = [];
      for (const id of ["D1", "D2"]) records.push((await store.accept(parseWakeAcceptanceRequest({
        token: undefined, agent_id: "alpha", delivery_id: id,
        event: { version: "noopolis.daimon.wake.v2", kind: "message", text: id, occurred_at: "2026-10-15T05:48:17.282Z" }
      }))).record);
      const ids = records.map((record) => record.acceptance_id);
      const acquired = await store.acquireClaim(ids[0]!, randomUUID(), ids, randomUUID());
      assert.equal(acquired.state, "acquired"); if (acquired.state !== "acquired") throw new Error("claim missing");
      for (const id of ids) await store.transitionClaimed(id, acquired.claim, "running");
      await store.transitionClaimed(ids[0]!, acquired.claim, "accepted", undefined, undefined, { deferred: true, clear_execution: true });
      assert.equal((await store.acquireClaim(ids[1]!, randomUUID(), ids, randomUUID())).state, "held");
      now += 240_000;
      if (takeover) {
        // New owner anchors the same agent claim on the OTHER batch member.
        const replacement = await store.acquireClaim(ids[1]!, randomUUID(), ids, randomUUID());
        assert.equal(replacement.state, "acquired"); if (replacement.state !== "acquired") throw new Error("replacement missing");
        for (const id of ids) await store.transitionClaimed(id, replacement.claim, "running");
      }
      const before = await store.activity();
      await assert.rejects(store.renewClaim(ids[0]!, acquired.claim), WakeExecutionClaimLostError);
      await assert.rejects(store.transitionClaimed(ids[1]!, acquired.claim, "completed", undefined, "stale"), WakeExecutionClaimLostError);
      await assert.rejects(store.transitionClaimed(ids[0]!, acquired.claim, "running"), WakeExecutionClaimLostError);
      assert.deepEqual(await store.activity(), before);
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
