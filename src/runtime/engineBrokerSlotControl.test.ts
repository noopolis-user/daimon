import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import test from "node:test";
import { EngineBrokerControlClient } from "./engineBrokerControlClient.js";
import { ENGINE_BROKER_VERSION, EngineBrokerFrameDecoder, encodeEngineBrokerFrame, parseEngineBrokerRequest, parseEngineBrokerResponse } from "./engineBrokerProtocol.js";
import { serveEngineBrokerConnection, type EngineBrokerServiceEngine } from "./engineBrokerService.js";

const ready = { providerProxyPort: 43123, mcpFacadePort: 43124, registrations: 2, credentialStale: false, realmLease: true, workerIsolation: true } as const;
const result = { text: "answer", workerPid: 42, workerUid: 2200, workerStartTime: "1", outcome: "completed", usage: null, model: "grok-4.6", requests: 0, limitReason: "none" } as const;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
function transport(engine: EngineBrokerServiceEngine) {
  const active = new Map<string, AbortController>();
  const clients: Socket[] = [];
  const connect = () => {
    const socket = new Duplex({ read() {} }), peer = new Duplex({ read() {} });
    socket._write = (chunk, _encoding, done) => { peer.push(chunk); done(); };
    peer._write = (chunk, _encoding, done) => { socket.push(chunk); done(); };
    socket._final = (done) => { peer.push(null); done(); };
    peer._final = (done) => { socket.push(null); done(); };
    socket.once("close", () => peer.destroy()); peer.once("close", () => socket.destroy());
    serveEngineBrokerConnection(peer as Socket, engine, active);
    clients.push(socket as Socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket as Socket;
  };
  return { connect, active, clients, client: new EngineBrokerControlClient("memory", connect) };
}

test("the real client/service routes repeated-agent turns and reset by slot, keeping replies private to their connections", async () => {
  const gates = [deferred(), deferred()], entered = [deferred(), deferred()];
  const resets: number[] = [], calls: number[] = [];
  const f = transport({ readiness: () => ready, close: async () => {}, resetSlot: async (slot) => { resets.push(slot); },
    turn: async (_agent, _wake, _prompt, _endpoint, _signal, _limits, _clock, slot) => {
      calls.push(slot!); entered[slot!]!.resolve(); await gates[slot!]!.promise;
      return { ...result, text: `private slot ${slot}`, workerUid: 2200 + slot! };
    } });
  const a = f.client.turn("same", "wake", "work", "http://127.0.0.1:1/mcp", undefined, { slot: 0 });
  const b = f.client.turn("same", "wake", "work", "http://127.0.0.1:1/mcp", undefined, { slot: 1 });
  await Promise.all(entered.map((entry) => entry.promise));
  assert.equal(f.active.size, 2); assert.deepEqual(calls, [0, 1]);
  gates[1]!.resolve(); assert.equal(await b, "private slot 1");
  await f.client.resetSlot(1); assert.deepEqual(resets, [1]);
  gates[0]!.resolve(); assert.equal(await a, "private slot 0");
});

test("a separate connection cannot cancel or observe a sibling's active turn even knowing its turn id", async (t) => {
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  let signal: AbortSignal | undefined;
  const f = transport({ readiness: () => ready, close: async () => {},
    turn: async (_agent, _wake, _prompt, _endpoint, received) => { signal = received; entered.resolve(); await finish.promise; return result; } });
  const pending = f.client.turn("same", "wake", "work", "http://127.0.0.1:1/mcp", undefined, { slot: 1 });
  await entered.promise;
  const key = [...f.active.keys()][0]!, turnId = key.slice(key.indexOf(":") + 1);
  const foreign = f.connect(), seen: unknown[] = [], decoder = new EngineBrokerFrameDecoder();
  foreign.on("data", (chunk) => seen.push(...decoder.push(chunk)));
  const closed = new Promise<void>((resolve) => foreign.once("close", resolve));
  foreign.write(encodeEngineBrokerFrame({ version: ENGINE_BROKER_VERSION, kind: "cancel_turn", requestId: "foreign", turnId }));
  await new Promise((done) => setImmediate(done));
  assert.equal(signal!.aborted, false);
  await closed; assert.deepEqual(seen, []);
  assert.equal(f.active.size, 1);
  finish.resolve(); assert.equal(await pending, "answer");
});

test("cancellation of the owning connection affects only its own slot", async () => {
  const entered = [deferred(), deferred()], finish = deferred();
  const signals: AbortSignal[] = [];
  const f = transport({ readiness: () => ready, close: async () => {},
    turn: async (_agent, _wake, _prompt, _endpoint, signal, _limits, _clock, slot) => {
      signals[slot!] = signal!; entered[slot!]!.resolve(); await finish.promise; return result;
    } });
  const controller = new AbortController();
  const a = f.client.turn("same", "wake", "work", "http://127.0.0.1:1/mcp", controller.signal, { slot: 0 });
  const refused = assert.rejects(a, /unavailable/u);
  const b = f.client.turn("same", "wake", "work", "http://127.0.0.1:1/mcp", undefined, { slot: 1 });
  await Promise.all(entered.map((entry) => entry.promise));
  controller.abort(); await refused; await new Promise((done) => setImmediate(done));
  assert.equal(signals[0]!.aborted, true); assert.equal(signals[1]!.aborted, false);
  finish.resolve(); assert.equal(await b, "answer");
});

test("slot requests and replies reject missing, malformed and extra fields", async () => {
  const reset = { version: ENGINE_BROKER_VERSION, kind: "reset_slot", requestId: "r", slot: 1 };
  assert.deepEqual(parseEngineBrokerRequest(reset), reset);
  const reply = { ...reset, kind: "slot_reset" };
  assert.deepEqual(parseEngineBrokerResponse(reply), reply);
  for (const slot of [undefined, null, -1, 1.5, "1", NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseEngineBrokerRequest({ ...reset, slot }));
    assert.throws(() => parseEngineBrokerResponse({ ...reply, slot }));
    const start = { version: ENGINE_BROKER_VERSION, kind: "start_turn", requestId: "r", turnId: "t", agentId: "a", wakeId: "w", prompt: "work", mcpEndpoint: "http://127.0.0.1:1/mcp" };
    if (slot !== undefined) assert.throws(() => parseEngineBrokerRequest({ ...start, slot }));
  }
  assert.throws(() => parseEngineBrokerRequest({ ...reset, workerUid: 2201 }));
  assert.throws(() => parseEngineBrokerResponse({ ...reply, path: "/any" }));
  const f = transport({ readiness: () => ready, close: async () => {}, turn: async () => result });
  await assert.rejects(f.client.resetSlot(0), /unavailable/u);
  await assert.rejects(f.client.resetSlot(-1), /invalid/u);
});

test("slot environment selects the training registration; production can omit it and malformed values refuse", async (t) => {
  const prior = process.env.DAIMON_ENGINE_BROKER_SLOT;
  t.after(() => { if (prior === undefined) delete process.env.DAIMON_ENGINE_BROKER_SLOT; else process.env.DAIMON_ENGINE_BROKER_SLOT = prior; });
  const seen: (number | undefined)[] = [];
  const f = transport({ readiness: () => ready, close: async () => {}, turn: async (...args) => { seen.push(args[7]); return result; } });
  delete process.env.DAIMON_ENGINE_BROKER_SLOT;
  await f.client.turn("a", "w", "work", "http://127.0.0.1:1/mcp");
  process.env.DAIMON_ENGINE_BROKER_SLOT = "1";
  await f.client.turn("a", "w", "work", "http://127.0.0.1:1/mcp");
  for (const invalid of ["", "-1", "01", "1.1", " ", "Infinity"]) {
    process.env.DAIMON_ENGINE_BROKER_SLOT = invalid;
    await assert.rejects(f.client.turn("a", "w", "work", "http://127.0.0.1:1/mcp"), /invalid/u);
  }
  assert.deepEqual(seen, [undefined, 1]);
});
