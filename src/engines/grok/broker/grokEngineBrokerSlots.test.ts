import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { assertBrokerTaskClockIsolation, brokerTaskClockFileFor } from "./grokBrokerSlot.js";
import { startGrokEngineBroker, type GrokEngineBrokerDependencies, type GrokEngineBrokerRegistration } from "./grokEngineBroker.js";
import { writeBrokerTaskClock } from "./grokBrokerTaskClock.js";
import { assertGrokWorkerConfigBytes } from "./grokWorkerHomeAttestation.js";
import { grokBrokerWorkerConfigPins, renderGrokBrokerWorkerConfig } from "./grokBrokerWorkerConfig.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const endpoint = "http://127.0.0.1:1/mcp";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-slots-"));
  const brokers: Awaited<ReturnType<typeof startGrokEngineBroker>>[] = [];
  const fileFor = (slot: number) => path.join(root, `clock-${slot}`, "faketime");
  const registrations: GrokEngineBrokerRegistration[] = [0, 1].map((slot) => ({
    agentId: "same-agent", slot, workerUid: 2200 + slot, workspace: `/workspace/${slot}`,
    profilePath: `/workers/${slot}/.grok/sandbox.toml`, eventsPath: `/workers/${slot}/.grok/sessions/sandbox-events.jsonl`,
    profileSha256: "a".repeat(64), usageLedgerPath: path.join(root, `usage-${slot}`, "usage.jsonl"),
    limits: { maxRequests: 4, maxTokens: 1000, timeoutMs: 5000 }, model: { model: "grok-4.6", reasoningEffort: "low" }
  }));
  for (const slot of [0, 1]) {
    await mkdir(path.dirname(fileFor(slot)), { mode: 0o755 });
    await chmod(path.dirname(fileFor(slot)), 0o755);
    await mkdir(path.join(root, `usage-${slot}`));
    await writeBrokerTaskClock(`+${100 + slot}`, fileFor(slot), process.getuid!());
  }
  const entered = [deferred(), deferred()], gates = [deferred(), deferred()];
  t.after(async () => { gates.forEach((gate) => gate.resolve()); await Promise.all(brokers.map((broker) => broker.close())); await rm(root, { recursive: true, force: true }); });
  const signals: AbortSignal[] = [], turnIds: string[] = [], offsets: string[] = [];
  let launches = 0, closed = 0;
  const live = new Set<string>();
  const deps: GrokEngineBrokerDependencies = {
    gatewayFetch: async () => new Response(JSON.stringify({ status: "ok", engines: ["grok"] }), { status: 200 }),
    needsTaskClockReconciliation: async (_profile, _pins, file) => {
      assert.ok([0, 1].some((slot) => file === brokerTaskClockFileFor(slot)));
      return true;
    },
    prepareAttestation: async (input) => {
      assert.deepEqual(input.configSha256, grokBrokerWorkerConfigPins(registrations[input.workerUid - 2200]!.model, input.workerUid - 2200));
      return { dev: 1, ino: 1, size: 0, configVariant: "clocked",
        denyPaths: [path.posix.dirname(brokerTaskClockFileFor(input.workerUid === 2200 ? 1 : 0))] };
    },
    createIsolationGuard: () => async () => {}, workerIdentityEmpty: async () => true,
    writeTaskClock: async (value, file) => {
      const slot = [0, 1].find((slot) => file === brokerTaskClockFileFor(slot));
      assert.notEqual(slot, undefined, "all publication and reset paths must address a registered slot");
      await writeBrokerTaskClock(value, fileFor(slot!), process.getuid!());
    },
    startProxy: async () => ({ port: 43123, close: async () => {},
      capabilities: { issue: (_agent, turn) => turn, revoke() {} }, registerIsolationGuard() {}, revokeIsolationGuard() {},
      registerTurn(turn) { assert.equal(live.has(turn), false); live.add(turn); },
      revokeTurn(turn) { live.delete(turn); } }),
    startMcp: async () => ({ register: (_agent, turn) => turn, revoke() {}, close: async () => { closed++; } }),
    runNative: async (_client, input, signal) => {
      launches++; signals[input.slot] = signal!; turnIds[input.slot] = input.turnId;
      offsets[input.slot] = await readFile(fileFor(input.slot), "utf8");
      entered[input.slot]!.resolve();
      await gates[input.slot]!.promise;
      const usage = { input_tokens: 10 + input.slot, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      return { text: [JSON.stringify({ type: "assistant", parent_tool_use_id: null, session_id: "s",
        message: { id: "m", role: "assistant", model: "daimon-broker-grok", usage, stop_reason: "end_turn", content: [{ type: "text", text: `slot ${input.slot}` }] } }), JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s",
        stop_reason: "end_turn", result: `slot ${input.slot}`, usage })].join("\n"),
        workerPid: 42 + input.slot, workerUid: 2200 + input.slot, startTicks: 1n,
        diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false,
          exitCode: 0, termSignal: 0, workerPid: 42 + input.slot, workerUid: 2200 + input.slot, startTicks: "1" } };
    }
  };
  const start = async (overrides: Partial<GrokEngineBrokerDependencies> = {}, regs = registrations) => {
    const broker = await startGrokEngineBroker({ nativeClient: "unused", gateway: { url: "http://127.0.0.1:9", key: "test-gateway-key-0123456789" },
      turnStore: path.join(root, "turns"), registrations: regs }, { ...deps, ...overrides });
    brokers.push(broker);
    return broker;
  };
  return { root, deps, start, registrations, entered, gates, signals, turnIds, offsets, fileFor,
    launches: () => launches, closed: () => closed, live };
}

test("same-agent slots overlap with distinct clocks, capabilities and usage; reset leaves the sibling active", async (t) => {
  const f = await fixture(t), broker = await f.start();
  assert.deepEqual(await Promise.all([0, 1].map((slot) => readFile(f.fileFor(slot), "utf8"))), ["+0\n", "+0\n"]);
  const a = broker.turn("same-agent", "same-wake", "work", endpoint, undefined, undefined, "-111.123", 0);
  const b = broker.turn("same-agent", "same-wake", "work", endpoint, undefined, undefined, "+222.456", 1);
  await Promise.all(f.entered.map((entry) => entry.promise));
  assert.equal(f.live.size, 2);
  assert.notEqual(f.turnIds[0], f.turnIds[1]);
  assert.deepEqual(f.offsets, ["-111.123\n", "+222.456\n"]);
  await assert.rejects(broker.resetSlot(1), /busy/u);
  await assert.rejects(broker.turn("same-agent", "overlap", "work", endpoint, undefined, undefined, "+3", 1), /already active/u);
  f.gates[0]!.resolve();
  assert.equal((await a).text, "slot 0");
  const siblingRecord = path.join(f.root, "turns", "slot-1", (await readdir(path.join(f.root, "turns", "slot-1")))[0]!);
  const before = await readFile(siblingRecord, "utf8");
  assert.equal(JSON.parse(before).state, "active");
  await broker.resetSlot(0);
  await assert.rejects(readdir(path.join(f.root, "turns", "slot-0")), { code: "ENOENT" });
  assert.equal(await readFile(siblingRecord, "utf8"), before);
  assert.equal(await readFile(f.fileFor(1), "utf8"), "+222.456\n");
  assert.equal(f.signals[1]!.aborted, false);
  assert.equal(f.closed(), 0);
  assert.equal(f.live.size, 1);
  f.gates[1]!.resolve();
  assert.equal((await b).text, "slot 1");
  assert.equal(await readFile(f.fileFor(1), "utf8"), "+0\n");
  for (const slot of [0, 1]) {
    const usage = JSON.parse(await readFile(path.join(f.root, `usage-${slot}`, "usage.jsonl"), "utf8"));
    const seal = JSON.parse(await readFile(path.join(f.root, `usage-${slot}`, "turns.jsonl"), "utf8"));
    assert.equal(usage.turn, f.turnIds[slot]); assert.equal(usage.input, 10 + slot);
    assert.equal(seal.turn, f.turnIds[slot]); assert.equal(seal.shell_clock, "task");
  }
  assert.equal((await broker.turn("same-agent", "same-wake", "work", endpoint, undefined, undefined, "+333", 0)).text, "slot 0");
  assert.equal(f.launches(), 3, "reset removes only this slot's replay state");
});

test("slot resolution refuses ambiguous agents, wrong agents, unknown slots and duplicate worker identities", async (t) => {
  const f = await fixture(t), broker = await f.start();
  await assert.rejects(broker.turn("same-agent", "w", "work", endpoint), /unavailable/u);
  await assert.rejects(broker.turn("wrong-agent", "w", "work", endpoint, undefined, undefined, undefined, 0), /unavailable/u);
  await assert.rejects(broker.turn("same-agent", "w", "work", endpoint, undefined, undefined, undefined, 99), /unavailable/u);
  await assert.rejects(broker.resetSlot(99), /unavailable/u);
  for (const key of ["slot", "workerUid"] as const) {
    await assert.rejects(f.start({}, [f.registrations[0]!, { ...f.registrations[1]!, [key]: f.registrations[0]![key] }]), /registration conflict/u);
  }
  assert.equal(f.launches(), 0);
  await broker.close();
  await assert.rejects(broker.resetSlot(0), /unavailable/u);
  await assert.rejects(broker.turn("same-agent", "w", "work", endpoint, undefined, undefined, undefined, 0), /unavailable/u);
});

test("a reset claims its slot before awaiting I/O and a failed reset fences only that slot", async (t) => {
  const f = await fixture(t), resetting = deferred(), release = deferred();
  let block = false;
  const broker = await f.start({ writeTaskClock: async (value, file) => {
    if (block && file === brokerTaskClockFileFor(0)) { resetting.resolve(); await release.promise; throw new Error("reset failed"); }
    await f.deps.writeTaskClock(value, file);
  } });
  block = true;
  const pending = broker.resetSlot(0);
  const failed = assert.rejects(pending, /reset failed/u);
  await resetting.promise;
  await assert.rejects(broker.resetSlot(0), /busy/u);
  await assert.rejects(broker.turn("same-agent", "w", "work", endpoint, undefined, undefined, undefined, 0), /already active/u);
  release.resolve(); await failed;
  await assert.rejects(broker.turn("same-agent", "w", "work", endpoint, undefined, undefined, undefined, 0), { code: "unavailable" });
  f.gates[1]!.resolve();
  assert.equal((await broker.turn("same-agent", "w", "work", endpoint, undefined, undefined, undefined, 1)).text, "slot 1");
  block = false; await broker.resetSlot(0);
  f.gates[0]!.resolve();
  assert.equal((await broker.turn("same-agent", "w", "work", endpoint, undefined, undefined, undefined, 0)).text, "slot 0");
});

test("worker clock config selects only its slot, rejects another slot's config and requires sibling deny mounts", () => {
  const policy = { model: "grok-4.6", reasoningEffort: "low" } as const;
  for (const slot of [0, 1]) {
    const config = renderGrokBrokerWorkerConfig(policy, "clocked", slot);
    assert.ok(config.includes(brokerTaskClockFileFor(slot)));
    assert.ok(!config.includes(brokerTaskClockFileFor(1 - slot)));
    assert.equal(assertGrokWorkerConfigBytes(Buffer.from(config), grokBrokerWorkerConfigPins(policy, slot)), "clocked");
    assert.throws(() => assertGrokWorkerConfigBytes(Buffer.from(config), grokBrokerWorkerConfigPins(policy, 1 - slot)), /unavailable/u);
    const peer = path.posix.dirname(brokerTaskClockFileFor(1 - slot));
    assertBrokerTaskClockIsolation("clocked", slot, [0, 1], [peer]);
    assert.throws(() => assertBrokerTaskClockIsolation("clocked", slot, [0, 1], []), /sibling/u);
    assert.throws(() => assertBrokerTaskClockIsolation("clocked", slot, [0, 1], [brokerTaskClockFileFor(1 - slot)]), /sibling/u);
    assert.throws(() => assertBrokerTaskClockIsolation("clocked", slot, [0, 1], [peer, path.posix.dirname(brokerTaskClockFileFor(slot))]), /own/u);
  }
  for (const slot of [-1, 0.5, NaN, Infinity]) assert.throws(() => brokerTaskClockFileFor(slot), /invalid/u);
  assertBrokerTaskClockIsolation("unclocked", 0, [0, 1], []);
});

test("startup and per-turn attestation both reject a clocked profile exposing its sibling", async (t) => {
  const f = await fixture(t);
  const exposed: GrokEngineBrokerDependencies["prepareAttestation"] = async () => ({ dev: 1, ino: 1, size: 0, configVariant: "clocked", denyPaths: [] });
  await assert.rejects(f.start({ prepareAttestation: exposed }), /sibling/u);
  const broker = await f.start({ prepareAttestation: exposed, needsTaskClockReconciliation: async () => false });
  await assert.rejects(broker.turn("same-agent", "w", "work", endpoint, undefined, undefined, undefined, 0), /turn failed/u);
  assert.equal(f.launches(), 0);
});

test("shutdown keeps its services until an admitted slot reset finishes", async (t) => {
  const f = await fixture(t), entered = deferred(), finish = deferred();
  let block = false;
  const broker = await f.start({ writeTaskClock: async (value, file) => {
    if (block) { entered.resolve(); await finish.promise; }
    await f.deps.writeTaskClock(value, file);
  } });
  block = true;
  const reset = broker.resetSlot(0); await entered.promise;
  const closing = broker.close();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.closed(), 0);
  finish.resolve(); await Promise.all([reset, closing]); assert.equal(f.closed(), 1);
});

test("a slot never publishes a native result carrying its sibling's worker UID", async (t) => {
  const f = await fixture(t);
  const broker = await f.start({ runNative: async (...args) => ({ ...await f.deps.runNative(...args), workerUid: 2201 }) });
  f.gates[0]!.resolve();
  await assert.rejects(broker.turn("same-agent", "wrong-uid", "work", endpoint, undefined, undefined, undefined, 0), { code: "engine_failed" });
  const seal = JSON.parse(await readFile(path.join(f.root, "usage-0", "turns.jsonl"), "utf8"));
  assert.equal(seal.outcome, "failed");
});

test("one-registration unclocked production still completes without an explicit slot or clock writes", async (t) => {
  const f = await fixture(t);
  const broker = await f.start({
    needsTaskClockReconciliation: async () => false,
    prepareAttestation: async () => ({ dev: 1, ino: 1, size: 0, configVariant: "unclocked", denyPaths: [] }),
    writeTaskClock: async () => { throw new Error("unclocked production must not write clocks"); }
  }, [f.registrations[0]!]);
  f.gates[0]!.resolve();
  assert.equal((await broker.turn("same-agent", "production", "work", endpoint)).text, "slot 0");
  await broker.resetSlot(0);
  await assert.rejects(readdir(path.join(f.root, "turns", "slot-0")), { code: "ENOENT" });
});

test("reset refuses a worker identity that remains alive and preserves its clock", async (t) => {
  const f = await fixture(t);
  let occupied = false;
  const broker = await f.start({ workerIdentityEmpty: async () => !occupied });
  await writeBrokerTaskClock("+987", f.fileFor(0), process.getuid!());
  occupied = true;
  await assert.rejects(broker.resetSlot(0), /busy/u);
  assert.equal(await readFile(f.fileFor(0), "utf8"), "+987\n");
  await assert.rejects(broker.turn("same-agent", "w", "work", endpoint, undefined, undefined, undefined, 0), { code: "unavailable" });
});

test("every turn attests the registration's own declared skills digest", async (t) => {
  const f = await fixture(t);
  const seen: (string | undefined)[] = [];
  const skillsSha256 = "c".repeat(64);
  const broker = await f.start({
    needsTaskClockReconciliation: async () => false,
    prepareAttestation: async (input) => { seen.push(input.skillsSha256); return { dev: 1, ino: 1, size: 0, configVariant: "unclocked", denyPaths: [] }; },
    writeTaskClock: async () => {}
  }, [{ ...f.registrations[0]!, skillsSha256 }, f.registrations[1]!]);
  f.gates.forEach((gate) => gate.resolve());
  await broker.turn("same-agent", "with-skills", "work", endpoint, undefined, undefined, undefined, 0);
  await broker.turn("same-agent", "without-skills", "work", endpoint, undefined, undefined, undefined, 1);
  assert.deepEqual(seen, [skillsSha256, undefined]);
});
