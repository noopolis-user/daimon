import assert from "node:assert/strict";
import { Agent, request as httpRequest, type ClientRequest } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const body = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
const answer = Buffer.from([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "use_tool", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");

type Reply = Readonly<{ status: number; text: string }>;
const send = (port: number, token: string, agent: Agent | false = false): Readonly<{ request: ClientRequest; reply: Promise<Reply> }> => {
  let request!: ClientRequest;
  const reply = new Promise<Reply>((resolve, reject) => {
    request = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent, headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject); request.end(body);
  });
  return { request, reply };
};

/** A real proxy whose upstream can be held open, counting calls and the most it ever had in flight at once. */
const harness = async (meter = new GrokBrokerTurnMeter({ maxRequests: 64, maxTokens: 1_000_000, timeoutMs: 600_000 })) => {
  let gate: Promise<void> = Promise.resolve(), release: () => void = () => undefined;
  const state = { calls: 0, open: 0, peak: 0 };
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => {
    state.calls++; state.open++; state.peak = Math.max(state.peak, state.open);
    try { await gate; } finally { state.open--; }
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: answer };
  }, undefined, 0);
  const token = proxy.capabilities.issue("agent", "turn");
  proxy.registerIsolationGuard("turn", async () => undefined);
  proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter });
  return {
    proxy, token, meter, state,
    hold: () => { gate = new Promise<void>((resolve) => { release = resolve; }); },
    release: () => release(),
    untilCalls: async (calls: number) => { while (state.calls < calls) await delay(2); }
  };
};

test("a strictly sequential client is never refused: back-to-back requests with no gap on one keep-alive connection", { timeout: 10_000 }, async () => {
  const rig = await harness();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const statuses: number[] = [];
    for (let index = 0; index < 24; index++) statuses.push((await send(rig.proxy.port, rig.token, agent).reply).status);
    assert.deepEqual(statuses, Array(24).fill(200));
    assert.deepEqual([rig.state.calls, rig.state.peak, rig.meter.snapshot().requests], [24, 1, 24]);
  } finally { agent.destroy(); await rig.proxy.close(); }
});

test("run54: a second copy of a request that reaches the proxy while the first is in flight is answered, never refused 429", { timeout: 10_000 }, async () => {
  // Grok logged one inference_start for loop 17; the proxy received two copies 4 ms
  // apart, admitted the first and refused the second — the one Grok was reading.
  // Mutation guard: answering `busy` with 429 again turns `live` into a 429 here.
  const rig = await harness();
  try {
    rig.hold();
    const abandoned = send(rig.proxy.port, rig.token);
    abandoned.reply.catch(() => undefined);
    await rig.untilCalls(1);
    const live = send(rig.proxy.port, rig.token);
    await delay(30);
    abandoned.request.destroy();
    await delay(30);
    assert.equal(rig.state.calls, 1, "the copy waits; it is never forwarded beside the first");
    rig.release();
    const reply = await live.reply;
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual([rig.state.calls, rig.state.peak, rig.meter.snapshot().requests, rig.meter.busy()], [2, 1, 2, false]);
  } finally { rig.release(); await rig.proxy.close(); }
});

test("a waiting request whose client hangs up is never admitted, counted or forwarded", { timeout: 10_000 }, async () => {
  // Mutation guard: dropping the `gone` check forwards a request nobody will read and bills it.
  const rig = await harness();
  try {
    rig.hold();
    const first = send(rig.proxy.port, rig.token);
    await rig.untilCalls(1);
    const waiter = send(rig.proxy.port, rig.token);
    waiter.reply.catch(() => undefined);
    await delay(30);
    waiter.request.destroy();
    await delay(30);
    rig.release();
    assert.equal((await first.reply).status, 200);
    await delay(50);
    assert.deepEqual([rig.state.calls, rig.meter.snapshot().requests], [1, 1]);
  } finally { rig.release(); await rig.proxy.close(); }
});

test("a waiting request whose turn ended meanwhile is refused no_active_turn, not forwarded", { timeout: 10_000 }, async () => {
  // Mutation guard: without the registration re-check a waiter outlives its turn and spends after it.
  const rig = await harness();
  try {
    rig.hold();
    const first = send(rig.proxy.port, rig.token);
    await rig.untilCalls(1);
    const waiter = send(rig.proxy.port, rig.token);
    await delay(30);
    rig.proxy.revokeTurn("turn"); rig.proxy.revokeIsolationGuard("turn");
    rig.release();
    assert.equal((await first.reply).status, 200);
    const refused = await waiter.reply;
    assert.deepEqual([refused.status, JSON.parse(refused.text).reason], [400, "no_active_turn"]);
    assert.equal(rig.state.calls, 1);
  } finally { rig.release(); await rig.proxy.close(); }
});

test("a limit tripped while a request waits refuses it with that limit at once", { timeout: 10_000 }, async () => {
  // Mutation guard: a trip that does not wake waiters leaves this request hanging until the test times out.
  const rig = await harness();
  try {
    rig.hold();
    const first = send(rig.proxy.port, rig.token);
    first.reply.catch(() => undefined);
    await rig.untilCalls(1);
    const waiter = send(rig.proxy.port, rig.token);
    await delay(30);
    rig.meter.trip("timeout");
    const refused = await Promise.race([waiter.reply, delay(2_000).then(() => ({ status: 0, text: "hung" }))]);
    assert.deepEqual([refused.status, refused.text], [429, JSON.stringify({ error: "turn limit reached", limit: "timeout" })]);
    assert.equal(rig.state.calls, 1);
  } finally { rig.release(); await rig.proxy.close(); }
});
