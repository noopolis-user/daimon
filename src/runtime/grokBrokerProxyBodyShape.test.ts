import assert from "node:assert/strict";
import test from "node:test";
import { formatGrokBrokerProxyBodyShape, GROK_PROXY_BODY_SHAPE_LIST_MAX, grokBrokerProxyBodyShape } from "./grokBrokerProxyBodyShape.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";
import { authorizeGrokBrokerProxyRequest, GrokBrokerProxyRequestRejection, type GrokBrokerProxyRejectionCheck } from "./grokBrokerProxyRequest.js";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";

const leanNames = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"];
const lean = leanNames.map((name) => ({ type: "function", function: { name, description: "SECRET-DESCRIPTION", parameters: { type: "object" } } }));
const SECRET = "SECRET-CONTENT-must-never-be-logged";
const leanBody = (overrides: Record<string, unknown> = {}) => ({ model: "grok-4.6", reasoning_effort: "low", stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: SECRET }, { role: "user", content: SECRET }, { role: "user", content: SECRET }], tools: lean, ...overrides });

test("the body shape names members, tools, roles and tool_choice and never content", () => {
  const body = Buffer.from(JSON.stringify(leanBody({ reasoning_effort: undefined, temperature: 1, tool_choice: "auto" })));
  const shape = grokBrokerProxyBodyShape(body);
  assert.deepEqual(shape, {
    bytes: body.byteLength,
    keys: ["messages", "model", "stream", "stream_options", "temperature", "tool_choice", "tools"],
    tools: leanNames, messages: 3, roles: ["system", "user*2"], tool_choice: "auto"
  });
  const line = formatGrokBrokerProxyBodyShape(shape);
  assert.equal(line, `bytes=${body.byteLength} keys=messages,model,stream,stream_options,temperature,tool_choice,tools tools=${leanNames.join(",")} messages=3 roles=system,user*2 tool_choice=auto`);
  assert.doesNotMatch(line, /SECRET|grok-4\.6|low/u, "no content, description, or member value");
});

test("worker-chosen names are admitted only as plain bounded identifiers", () => {
  const hostile = `sk-${"x".repeat(80)}`;
  const body = Buffer.from(JSON.stringify({ [`a b\n${SECRET}`]: 1, messages: [{ role: SECRET + " " }, "x"], tools: [{ type: "function", function: { name: hostile } }, 7], tool_choice: { type: "function", function: { name: "session_title" } } }));
  const shape = grokBrokerProxyBodyShape(body);
  assert.deepEqual(shape.tools, ["<invalid>", "<invalid>"]);
  assert.deepEqual(shape.roles, ["<invalid>*2"]);
  assert.equal(shape.tool_choice, "object:session_title");
  assert.ok(shape.keys?.includes("<invalid>"));
  assert.doesNotMatch(formatGrokBrokerProxyBodyShape(shape), /SECRET|sk-x/u);
  const many = grokBrokerProxyBodyShape(Buffer.from(JSON.stringify({ tools: Array.from({ length: 100 }, (_, i) => ({ function: { name: `t${i}` } })), messages: Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "user" : "assistant" })) })));
  assert.equal((many.tools as readonly string[]).length, GROK_PROXY_BODY_SHAPE_LIST_MAX);
  assert.equal((many.tools as readonly string[]).at(-1), "<truncated>");
  assert.equal(many.roles?.length, GROK_PROXY_BODY_SHAPE_LIST_MAX);
  assert.equal(many.messages, 100);
  assert.deepEqual(grokBrokerProxyBodyShape(Buffer.from("not json")), { bytes: 8 });
  assert.deepEqual(grokBrokerProxyBodyShape(Buffer.from("[1]")), { bytes: 3 });
  assert.deepEqual(grokBrokerProxyBodyShape(Buffer.from("{}")), { bytes: 2, keys: [], tools: "absent", messages: "invalid" });
});

test("each body-gate check refuses under its own reason code", () => {
  const caps = new EngineBrokerCapabilities(); const token = caps.issue("a", "t");
  const headers = { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" };
  const run = (body: unknown, extra: Partial<{ method: string; headers: Record<string, string | undefined>; raw: Uint8Array }> = {}): GrokBrokerProxyRejectionCheck | "ok" => {
    try { authorizeGrokBrokerProxyRequest({ method: extra.method ?? "POST", pathname: "/v1/chat/completions", headers: extra.headers ?? headers, body: extra.raw ?? Buffer.from(JSON.stringify(body)), agentId: "a", turnId: "t" }, caps, "real-bearer"); return "ok"; }
    catch (error) { assert.ok(error instanceof GrokBrokerProxyRequestRejection, String(error)); assert.match(error.message, /rejected/u); return error.check; }
  };
  assert.equal(run(leanBody()), "ok");
  assert.equal(run(leanBody(), { method: "GET" }), "route");
  assert.equal(run(undefined, { raw: Buffer.alloc(2 * 1024 * 1024 + 1, 32) }), "body_size");
  assert.equal(run(leanBody(), { headers: { ...headers, authorization: "Bearer short" } }), "bearer");
  assert.equal(run(leanBody(), { headers: { ...headers, authorization: `Bearer ${"Z".repeat(48)}` } }), "scope");
  assert.equal(run(leanBody(), { headers: { ...headers, "x-grok-client-version": "1.0.35" } }), "client_version");
  assert.equal(run(undefined, { raw: Buffer.from("{nope") }), "json");
  assert.equal(run(leanBody({ stream: false })), "envelope");
  assert.equal(run(leanBody({ model: "grok-build" })), "model");
  assert.equal(run(leanBody({ reasoning_effort: "high" })), "reasoning_effort");
  assert.equal(run(leanBody({ tools: lean.slice(1) })), "tools");
  assert.equal(run(leanBody({ n: 2 })), "members");
  assert.equal(run(leanBody({ stream_options: "yes" })), "stream_options");
});

test("a refused body names its failed check and content-free shape on stderr and in the 400 body", async () => {
  const lines: string[] = []; const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let upstreamCalls = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => { upstreamCalls++; return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }; }, undefined, 0);
  try {
    const token = proxy.capabilities.issue("agent", "turn");
    proxy.registerIsolationGuard("turn", async () => undefined);
    proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter: new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 }) });
    const body = JSON.stringify(leanBody({ tools: [...lean, { type: "function", function: { name: "write" } }] }));
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" }, body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "broker refused this request", reason: "request_body_rejected", check: "tools" });
    assert.equal(upstreamCalls, 0);
    assert.deepEqual(lines, [`[grok-proxy] refused: request_body_rejected check=tools bytes=${Buffer.byteLength(body)} keys=messages,model,reasoning_effort,stream,stream_options,tools tools=${leanNames.join(",")},write messages=3 roles=system,user*2\n`]);
    assert.ok(!lines[0]!.includes(token) && !lines[0]!.includes("provider-token") && !lines[0]!.includes("SECRET"));
  } finally { process.stderr.write = original; await proxy.close(); }
});
