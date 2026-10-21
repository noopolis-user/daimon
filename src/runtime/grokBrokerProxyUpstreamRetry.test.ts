import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { startGrokBrokerProxy, type GrokBrokerUpstream } from "./grokBrokerProxy.js";
import { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";
import { isGrokUpstreamTransportFault } from "./grokBrokerUpstreamFault.js";

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const body = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
const answer = [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "use_tool", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

type Script = "cut" | "ok" | number;

/**
 * A real provider stand-in on loopback: `cut` writes the status line, headers
 * and half a body, then destroys the socket — the run57 fault, reaching the
 * proxy through real `fetch` as `TypeError: terminated <- SocketError: other
 * side closed`; `ok` answers 200; a number answers that status.
 */
async function provider(script: readonly Script[]): Promise<Readonly<{ server: Server; calls: () => number; upstream: GrokBrokerUpstream }>> {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    const step = script[Math.min(calls++, script.length - 1)]!;
    if (step === "cut") { response.writeHead(200, { "content-type": "text/event-stream", "content-length": String(answer.length * 2) }); response.write(answer.slice(0, 40)); setTimeout(() => response.socket?.destroy(), 5); return; }
    if (step === "ok") { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(answer); return; }
    response.writeHead(step, { "content-type": "application/json" }); response.end('{"error":"upstream said no"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  // The shipped default upstream, aimed at loopback instead of the provider.
  const upstream: GrokBrokerUpstream = async (prepared, signal) => {
    const result = await fetch(url, { method: "POST", headers: prepared.headers, body: Buffer.from(prepared.body), ...(signal === undefined ? {} : { signal }) });
    return { status: result.status, headers: { "content-type": result.headers.get("content-type") ?? "application/json" }, body: new Uint8Array(await result.arrayBuffer()) };
  };
  return { server, calls: () => calls, upstream };
}

const send = (port: number, token: string): Promise<Readonly<{ status: number; text: string }>> => new Promise((resolve, reject) => {
  const request = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => {
    const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
  });
  request.on("error", reject); request.end(body);
});

async function withProxy(script: readonly Script[], run: (rig: Readonly<{ reply: () => ReturnType<typeof send>; meter: GrokBrokerTurnMeter; calls: () => number }>) => Promise<void>, maxRequests = 64): Promise<void> {
  const stand = await provider(script);
  const meter = new GrokBrokerTurnMeter({ maxRequests, maxTokens: 1_000_000, timeoutMs: 600_000 });
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, stand.upstream, undefined, 0);
  const token = proxy.capabilities.issue("agent", "turn");
  proxy.registerIsolationGuard("turn", async () => undefined);
  proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter });
  try { await run({ reply: () => send(proxy.port, token), meter, calls: stand.calls }); }
  finally { await proxy.close(); await new Promise<void>((resolve) => stand.server.close(() => resolve())); }
}

test("run57: an upstream socket closed mid-response is retried once as a fresh request, and the worker gets its 200", { timeout: 10_000 }, async () => {
  // Mutation guard: without the retry the worker reads 503 broker unavailable here.
  await withProxy(["cut", "ok"], async ({ reply, meter, calls }) => {
    const answered = await reply();
    assert.equal(answered.status, 200, answered.text);
    assert.equal(answered.text, answer);
    const snapshot = meter.snapshot();
    assert.deepEqual([calls(), snapshot.requests, snapshot.estimatedRequests, meter.busy()], [2, 2, 1, false], "both attempts are metered; the cut one at the missing-usage estimate");
    assert.ok(snapshot.timings.every((timing) => timing.endedAt !== undefined));
    assert.deepEqual(snapshot.timings[1]!.usage, { input: 10, cacheRead: 0, cacheWrite: 0, output: 2, total: 12 });
    assert.equal(meter.failedResponse(), undefined, "a retried success is not an error response");
  });
});

test("two dropped connections in a row are refused 503 with no third attempt", { timeout: 10_000 }, async () => {
  // Mutation guard: an unbounded retry makes a third upstream call here.
  await withProxy(["cut", "cut", "ok"], async ({ reply, meter, calls }) => {
    const answered = await reply();
    assert.equal(answered.status, 503, answered.text);
    assert.deepEqual([calls(), meter.snapshot().requests, meter.snapshot().estimatedRequests], [2, 2, 2]);
    assert.equal(meter.failedResponse()?.kind, "upstream_failed");
  });
});

for (const status of [400, 429, 500, 503]) {
  test(`an upstream HTTP ${status} is the provider's answer: passed through, never retried`, { timeout: 10_000 }, async () => {
    // Mutation guard: classifying a status (or a thrown 5xx) as transport retries it here.
    await withProxy([status, "ok"], async ({ reply, meter, calls }) => {
      const answered = await reply();
      assert.equal(answered.status, status);
      assert.deepEqual([calls(), meter.snapshot().requests], [1, 1]);
      assert.equal(meter.failedResponse()?.kind, "upstream_failed");
    });
  });
}

test("the retry is limit-checked: a turn at its request ceiling is refused 429, never forwarded again", { timeout: 10_000 }, async () => {
  // Mutation guard: retrying on the first admission bypasses `maxRequests` and makes a second call.
  await withProxy(["cut", "ok"], async ({ reply, meter, calls }) => {
    const answered = await reply();
    assert.equal(answered.status, 429, answered.text);
    assert.match(answered.text, /"limit":"requests"/u);
    assert.deepEqual([calls(), meter.snapshot().requests, meter.snapshot().limitReason], [1, 1, "requests"]);
  }, 1);
});

test("only transport faults classify as retryable: never an abort, an aborted signal, or an ordinary error", () => {
  const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  assert.equal(isGrokUpstreamTransportFault(new TypeError("terminated", { cause: socket })), true);
  assert.equal(isGrokUpstreamTransportFault(new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) })), true);
  assert.equal(isGrokUpstreamTransportFault(Object.assign(new Error("read"), { code: "ECONNRESET" })), true);
  const aborted = new AbortController(); aborted.abort();
  assert.equal(isGrokUpstreamTransportFault(new TypeError("terminated", { cause: socket }), aborted.signal), false);
  assert.equal(isGrokUpstreamTransportFault(new DOMException("aborted", "AbortError")), false);
  assert.equal(isGrokUpstreamTransportFault(new Error("credential read failed")), false);
  assert.equal(isGrokUpstreamTransportFault("terminated"), false);
});

test("a broker refusal of a known turn's request is noted as broker_refused; one that never reached upstream is not retried", { timeout: 10_000 }, async () => {
  const stand = await provider(["ok"]);
  const meter = new GrokBrokerTurnMeter({ maxRequests: 64, maxTokens: 1_000_000, timeoutMs: 600_000 });
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, stand.upstream, undefined, 0);
  const token = proxy.capabilities.issue("agent", "turn");
  proxy.registerIsolationGuard("turn", async () => { throw new Error("attestation failed"); });
  proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter });
  try {
    const answered = await send(proxy.port, token);
    assert.equal(answered.status, 400, answered.text);
    assert.deepEqual([stand.calls(), meter.snapshot().requests, meter.failedResponse()?.kind], [0, 0, "broker_refused"]);
  } finally { await proxy.close(); await new Promise<void>((resolve) => stand.server.close(() => resolve())); }
});
