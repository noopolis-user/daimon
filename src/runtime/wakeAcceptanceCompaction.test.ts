import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AttentionDispatcher } from "./attentionDispatcher.js";
import type { AttentionRegistry } from "./attention.js";
import type { OrganizationRuntimeHost, OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { WakeAcceptanceStore } from "./wakeAcceptanceStore.js";
import { WAKE_ACCEPTANCE_COMPACTION_THRESHOLD } from "./wakeAcceptanceRetention.js";
import { parseWakeAcceptanceRequest, wakeAcceptanceDigest } from "./wakeAcceptanceTypes.js";
import { WakeFuse } from "./wakeFuse.js";

const options = { processIdentity: async () => ({ pid: 1, process_start: "test", boot_id: "test", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true };
const request = (delivery_id: string) => parseWakeAcceptanceRequest({ token: "test", agent_id: "alpha", delivery_id,
  event: { version: "noopolis.daimon.wake.v2", kind: "message", text: delivery_id, occurred_at: new Date().toISOString() } });
const filename = (delivery: string) => `${createHash("sha256").update(`alpha\0${delivery}`).digest("hex")}.json`;
const modes = ["recoverable", "activity", "activityWithExecutionErrors"] as const;
const scan = (store: WakeAcceptanceStore, mode: typeof modes[number]) => mode === "recoverable" ? store.recoverable(new Set(["alpha"])) : store[mode]();

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wake-compaction-")); await chmod(root, 0o700);
  const store = await WakeAcceptanceStore.open(root, options);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const queued = (await store.accept(request("queued"))).record;
  return { root, store, queued };
}

async function seedTerminal(root: string) {
  for (let n = 0; n < WAKE_ACCEPTANCE_COMPACTION_THRESHOLD - 1; n++) {
    const req = request(`terminal-${n}`), at = new Date(Date.now() - 100_000 + n).toISOString();
    await writeFile(path.join(root, filename(req.delivery_id)), JSON.stringify({ acceptance_id: randomUUID(), agent_id: "alpha", delivery_id: req.delivery_id,
      request_digest: wakeAcceptanceDigest(req), event: req.event, state: "completed", accepted_at: at, updated_at: at }), { mode: 0o600 });
  }
}

// Only control the interleaving: enumeration, real accept/compaction, then the original reads.
function afterListing(store: WakeAcceptanceStore, action: () => Promise<void>) {
  const internal = store as unknown as { files(): Promise<readonly string[]> };
  const files = internal.files.bind(store);
  internal.files = async () => { const listed = await files(); internal.files = files; await action(); return listed; };
}

for (const mode of modes) test(`${mode} tolerates real concurrent terminal compaction without losing queued work`, { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); await seedTerminal(f.root);
  afterListing(f.store, async () => {
    assert.equal((await f.store.accept(request("new-arrival"))).created, true);
    const files = (await readdir(f.root)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
    assert.ok(files.length < WAKE_ACCEPTANCE_COMPACTION_THRESHOLD, "the real retention path removed terminal receipts");
    assert.ok(!files.includes(filename("terminal-0")));
  });
  const rows = await scan(f.store, mode);
  assert.equal(rows.find((row) => row.acceptance_id === f.queued.acceptance_id)?.state, "accepted");
  assert.deepEqual((await f.store.recoverable(new Set(["alpha"]))).map((row) => row.delivery_id), ["queued", "new-arrival"]);
});

test("default dispatcher executes durable queued work across real compaction instead of parking on ENOENT", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); await seedTerminal(f.root);
  const usage = path.join(f.root, "usage"); await mkdir(usage); await writeFile(path.join(usage, "usage.jsonl"), "");
  const fuse = await WakeFuse.open({ organizationKey: "test", environment: { DAIMON_WAKE_FUSE_DIRECTORY: usage,
    DAIMON_TURN_USAGE_LEDGER_PATH: path.join(usage, "usage.jsonl"), DAIMON_WAKE_FUSE_EPOCH: "test" } });
  const registry: AttentionRegistry = new Map(), executed: string[] = [];
  let idle!: () => void;
  const done = new Promise<void>((resolve) => { idle = resolve; });
  const dispatcher = new AttentionDispatcher({ store: f.store, fuse, registry, token: "test", onIdle: idle,
    agents: [{ id: "alpha", name: "Alpha", instructions: "Work", workspacePath: "/workspace", runtimeHomePath: "/runtime", engine: { kind: "codex" }, attention: {} }],
    host: { wake: async (wake: OrganizationRuntimeWakeRequest) => {
      const turn = registry.get("alpha")!;
      for (const message of turn.messages) { executed.push(message.delivery_id); await turn.disposition(message.delivery_id, "complete"); }
      return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: "alpha", wakeId: wake.event.id, text: "done", durationMs: 1 };
    } } as OrganizationRuntimeHost });
  afterListing(f.store, async () => { await f.store.accept(request("new-arrival")); });
  try {
    dispatcher.notify("alpha", true); await done;
    assert.equal(dispatcher.failure("alpha"), undefined);
    assert.deepEqual(executed, ["queued", "new-arrival"]);
    assert.equal((await f.store.status(f.queued.acceptance_id))?.state, "completed");
    assert.equal((await fuse.snapshot("alpha")).executions_used, 2);
  } finally { await dispatcher.stop(); }
});

for (const mode of modes) for (const damage of ["malformed", "permissions", "replaced-root"] as const) {
  test(`${mode} still rejects ${damage} during enumeration`, async (t) => {
    const f = await fixture(t), file = path.join(f.root, filename("queued"));
    const displaced = `${f.root}-displaced`;
    t.after(async () => { await rm(displaced, { recursive: true, force: true }); });
    afterListing(f.store, async () => {
      if (damage === "malformed") await writeFile(file, "{");
      else if (damage === "permissions") await chmod(file, 0o644);
      else { await rename(f.root, displaced); await mkdir(f.root, { mode: 0o700 }); }
    });
    try { await assert.rejects(scan(f.store, mode), damage === "malformed" ? SyntaxError : /unsafe|changed after validation/); }
    finally { if (damage === "replaced-root") { await rm(f.root, { recursive: true }); await rename(displaced, f.root); } }
  });
}
