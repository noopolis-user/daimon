import assert from "node:assert/strict";
import test from "node:test";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { authorizeGrokBrokerProxyRequest, GrokBrokerProxyRequestRejection } from "./grokBrokerProxyRequest.js";
import { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";

const leanNames = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"];
const lean = leanNames.map((name) => ({ type: "function", function: { name, description: "d", parameters: { type: "object" } } }));
const history = [{ role: "system", content: "s" }, { role: "user", content: "task" }, { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } }] }, { role: "tool", content: "out", tool_call_id: "c1" }];
/**
 * Grok 1.0.34's auto-compaction summary request, member for member as the
 * pinned binary sent it to a stub upstream (training image, 2026-10-21): the
 * same model and lean tools, `temperature: 1`, `tool_choice: "auto"`, and no
 * `reasoning_effort`. The second ("two-pass") request has the same members.
 */
const compactionBody = (overrides: Record<string, unknown> = {}) => ({
  model: "grok-4.6", messages: [...history, { role: "user", content: "Your task is to produce a faithful, concise summary of the conversation so far" }],
  temperature: 1, tools: lean, tool_choice: "auto", stream: true, stream_options: { include_usage: true }, ...overrides
});
const authorize = (body: unknown, effort: "low" | "high" = "low") => {
  const caps = new EngineBrokerCapabilities(); const token = caps.issue("a", "t");
  return authorizeGrokBrokerProxyRequest({ method: "POST", pathname: "/v1/chat/completions", headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" }, body: Buffer.from(JSON.stringify(body)), agentId: "a", turnId: "t" }, caps, "real-bearer", { model: "grok-4.6", reasoningEffort: effort });
};
const checkOf = (body: unknown): string => { try { authorize(body); return "ok"; } catch (error) { assert.ok(error instanceof GrokBrokerProxyRequestRejection); return error.check; } };

test("Grok's auto-compaction request is forwarded as an ordinary lean request with the declared effort", () => {
  for (const effort of ["low", "high"] as const) {
    const upstream = authorize(compactionBody(), effort);
    assert.equal(upstream.compaction, true);
    assert.equal(upstream.headers["x-grok-model-override"], "grok-4.6");
    const forwarded = JSON.parse(Buffer.from(upstream.body).toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(forwarded).sort(), ["messages", "model", "reasoning_effort", "stream", "stream_options", "tools"], "exactly the lean member set");
    assert.equal(forwarded.reasoning_effort, effort, "effort is pinned, never left to a provider default");
    assert.deepEqual(forwarded.messages, compactionBody().messages);
    assert.deepEqual(forwarded.tools, lean);
  }
  const ordinary = authorize({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: history, tools: lean });
  assert.equal(ordinary.compaction, undefined, "an ordinary worker request is not marked");
});

test("only the exact captured compaction shape is admitted; every spend check still holds", () => {
  assert.equal(checkOf(compactionBody()), "ok");
  assert.equal(checkOf(compactionBody({ model: "grok-build" })), "model");
  assert.equal(checkOf(compactionBody({ tools: [...lean, { type: "function", function: { name: "write" } }] })), "tools");
  assert.equal(checkOf(compactionBody({ tools: [{ type: "function", function: { name: "session_title" } }] })), "tools");
  for (const overrides of [
    { tool_choice: "required" }, { tool_choice: "none" }, { tool_choice: { type: "function", function: { name: "run_terminal_command" } } },
    { temperature: 0 }, { temperature: 2 }, { temperature: "1" },
    { stream_options: undefined }, { max_tokens: 100, stream_options: undefined },
    { reasoning_effort: "low" }, { reasoning_effort: "high", temperature: undefined },
    { n: 2 }
  ]) assert.notEqual(checkOf(compactionBody(overrides)), "ok", JSON.stringify(overrides));
  assert.equal(checkOf(compactionBody({ stream: false })), "envelope");
});

test("a compaction summary is metered like any request and is never recorded as the turn's final reply", async () => {
  const forwarded: Record<string, unknown>[] = [];
  const sse = (content: string) => Buffer.from([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } })}`,
    "data: [DONE]", ""
  ].join("\n\n"));
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async (request) => {
    forwarded.push(JSON.parse(Buffer.from(request.body).toString("utf8")) as Record<string, unknown>);
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: sse(forwarded.length === 1 ? "summary of the session" : "done") };
  }, undefined, 0);
  try {
    const token = proxy.capabilities.issue("agent", "turn");
    const meter = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 });
    proxy.registerIsolationGuard("turn", async () => undefined);
    proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter });
    const post = (body: unknown) => fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" }, body: JSON.stringify(body) });
    const compaction = await post(compactionBody()); await compaction.arrayBuffer();
    assert.equal(compaction.status, 200);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0]!.reasoning_effort, "low");
    assert.equal("temperature" in forwarded[0]! || "tool_choice" in forwarded[0]!, false);
    assert.equal(meter.snapshot().requests, 1, "the summary request is admitted through the meter and counted");
    assert.equal(meter.finalReply(), undefined, "a summary that stopped is not the turn's final reply");
    const final = await post({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: history, tools: lean }); await final.arrayBuffer();
    assert.equal(meter.finalReply()?.text, "done", "an ordinary stopped answer still is");
  } finally { await proxy.close(); }
});

test("a compaction after the final reply keeps that reply", async () => {
  const sse = (content: string) => Buffer.from([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } })}`,
    "data: [DONE]", ""
  ].join("\n\n"));
  let calls = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => {
    calls += 1;
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: sse(calls === 1 ? "done" : "summary of the session") };
  }, undefined, 0);
  try {
    const token = proxy.capabilities.issue("agent", "turn");
    const meter = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 });
    proxy.registerIsolationGuard("turn", async () => undefined);
    proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter });
    const post = (body: unknown) => fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" }, body: JSON.stringify(body) });
    const final = await post({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: history, tools: lean }); await final.arrayBuffer();
    assert.equal(meter.finalReply()?.text, "done");
    const compaction = await post(compactionBody()); await compaction.arrayBuffer();
    assert.equal(compaction.status, 200);
    assert.equal(meter.snapshot().requests, 2);
    assert.equal(meter.finalReply()?.text, "done", "a compaction summary never erases the reply before it");
  } finally { await proxy.close(); }
});
