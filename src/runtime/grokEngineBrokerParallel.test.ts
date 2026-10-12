import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGrokBrokerProxyHandler, type GrokBrokerUpstream } from "./grokBrokerProxy.js";
import { startGrokEngineBroker, type GrokEngineBrokerDependencies } from "./grokEngineBroker.js";
import { GrokBrokerRunBudget } from "./grokBrokerRunBudget.js";
import { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";
import { GrokInferenceGrants } from "./grokInferenceGrants.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const tools = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"];
const body = (text: string, subject = true) => JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true,
  stream_options: { include_usage: true }, messages: [{ role: "user", content: text }],
  ...(subject ? { tools: tools.map(name => ({ type: "function", function: { name } })) } : {}) });
async function post(proxy: ReturnType<typeof createGrokBrokerProxyHandler>, token: string, text: string, subject = true) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST"; req.url = "/v1/chat/completions";
  req.headers = { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" };
  req.push(body(text, subject)); req.push(null);
  let status = 0, content = "";
  await proxy.serve(req, { writeHead(code: number) { status = code; },
    end(value: string | Uint8Array) { content = Buffer.from(value).toString(); } } as unknown as ServerResponse);
  return { status, content };
}

// Real broker startup, per-slot registries, proxy admission and ledger publication;
// only native process execution, credential authority and upstream are fakes.
test("four concurrent fake trials retain slot state and share one subject/judge/optimizer request cap", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "parallel-broker-"));
  const gate = deferred(), allEntered = deferred();
  let entered = 0;
  const forwarded: string[] = [];
  let proxy!: ReturnType<typeof createGrokBrokerProxyHandler>;
  const registrations = Array.from({ length: 4 }, (_, slot) => ({
    agentId: "agent", slot, workerUid: 2200 + slot, workspace: `/workspace/${slot}`,
    profilePath: `/workers/${slot}/.grok/sandbox.toml`, eventsPath: `/workers/${slot}/.grok/sessions/sandbox-events.jsonl`,
    profileSha256: "a".repeat(64), usageLedgerPath: path.join(root, `usage-${slot}`, "usage.jsonl"),
    limits: { maxRequests: 8, maxTokens: 100_000, timeoutMs: 10_000 }, model: { model: "grok-4.6" as const, reasoningEffort: "low" as const }
  }));
  await Promise.all(registrations.map(r => mkdir(path.dirname(r.usageLedgerPath))));
  const upstream: GrokBrokerUpstream = async request => {
    const text = JSON.parse(Buffer.from(request.body).toString()).messages[0].content;
    forwarded.push(text);
    if (text.startsWith("slot-")) { if (++entered === 4) allEntered.resolve(); await gate.promise; }
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 }
    })) };
  };
  const deps: GrokEngineBrokerDependencies = {
    acquireLease: async () => ({ close: async () => {} }),
    createAuthority: () => ({ initialize: async () => {}, accessToken: async () => "fake", markRejected: async () => {}, isStale: () => false }),
    needsTaskClockReconciliation: async () => false,
    prepareAttestation: async () => ({ dev: 1, ino: 1, size: 0, configVariant: "unclocked", denyPaths: [] }),
    createIsolationGuard: () => async () => {}, writeTaskClock: async () => {}, workerIdentityEmpty: async () => true,
    startProxy: async (authority, _upstream, policy, _port, grants, budget) => {
      proxy = createGrokBrokerProxyHandler(authority, upstream, policy, grants, budget);
      return { ...proxy, port: 43123, close: async () => {} };
    },
    startMcp: async () => ({ register: (_agent, turn) => turn, revoke() {}, close: async () => {} }),
    runNative: async (_client, input) => {
      const reply = await post(proxy, input.providerCapability, `slot-${input.slot}`);
      assert.equal(reply.status, 200);
      assert.equal(JSON.parse(reply.content).choices[0].message.content, `slot-${input.slot}`);
      const result = `slot-${input.slot}`;
      return { text: JSON.stringify({ type: "assistant", parent_tool_use_id: null, session_id: "s",
        message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: result }] } }) + "\n" + JSON.stringify({ type: "result", subtype: "success", is_error: false,
        session_id: "s", stop_reason: "end_turn", result }), workerPid: 42 + input.slot, workerUid: 2200 + input.slot, startTicks: 1n,
        diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false,
          exitCode: 0, termSignal: 0, workerPid: 42 + input.slot, workerUid: 2200 + input.slot, startTicks: "1" } };
    }
  };
  const options = { grokCommand: "unused", nativeClient: "unused", credentialHome: root,
    turnStore: path.join(root, "turns"), runRequestStore: path.join(root, "persistent-budget"),
    registrations, inferenceLedgerPath: path.join(root, "inference.jsonl"), maxRunRequests: 6 };
  let broker = await startGrokEngineBroker(options, deps);
  t.after(async () => { gate.resolve(); await broker.close(); await rm(root, { recursive: true, force: true }); });
  const trials = registrations.map(r => broker.turn("agent", "same-wake", "work", "http://127.0.0.1:1/mcp", undefined, undefined, undefined, r.slot));
  await allEntered.promise;
  const judge = broker.requestInferenceGrant({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" });
  const optimizer = broker.requestInferenceGrant({ model: "grok-4.6", reasoningEffort: "low", purpose: "optimizer" });
  assert.deepEqual((await Promise.all([post(proxy, judge.token, "judge", false), post(proxy, optimizer.token, "optimizer", false)])).map(r => r.status), [200, 200]);
  assert.equal((await post(proxy, judge.token, "over-cap", false)).status, 429);
  gate.resolve();
  assert.deepEqual((await Promise.all(trials)).map(r => r.text), ["slot-0", "slot-1", "slot-2", "slot-3"]);
  const turnIds = new Set<string>();
  for (const r of registrations) {
    const rows = (await readFile(r.usageLedgerPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.length, 1); assert.equal(rows[0].calls, 1);
    turnIds.add(rows[0].turn);
    const requests = (await readFile(path.join(path.dirname(r.usageLedgerPath), "requests.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].turn, rows[0].turn);
  }
  assert.equal(turnIds.size, 4);
  await broker.resetSlot(0);
  assert.equal(JSON.parse(await readFile(path.join(options.runRequestStore, "run-requests.json"), "utf8")).used, 6);
  await broker.close();
  // Container replacement discards the slot tmpfs but retains the run budget volume.
  await rm(options.turnStore, { recursive: true, force: true });
  broker = await startGrokEngineBroker(options, deps);
  const resumed = broker.requestInferenceGrant({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" });
  assert.equal((await post(proxy, resumed.token, "restart-over-cap", false)).status, 429);
  assert.equal(forwarded.length, 6);
});

for (const subject of [true, false]) test(`the shared cap charges credential retries and refuses later requests (subject=${subject})`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "parallel-budget-retry-"));
  const budget = await GrokBrokerRunBudget.open(1, path.join(root, "budget.json"));
  const grants = new GrokInferenceGrants();
  t.after(async () => { grants.close(); await rm(root, { recursive: true, force: true }); });
  let forwarded = 0;
  const proxy = createGrokBrokerProxyHandler({ accessToken: async () => "fake", markRejected: async () => {} },
    async () => { forwarded++; return { status: 401, headers: {}, body: Buffer.from("{}") }; }, undefined, grants, budget);
  proxy.registerIsolationGuard("turn", async () => {});
  proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" },
    meter: new GrokBrokerTurnMeter({ maxRequests: 8, maxTokens: 100_000, timeoutMs: 10_000 }) });
  const token = subject ? proxy.capabilities.issue("agent", "turn")
    : grants.issue({ model: "grok-4.6", reasoningEffort: "low", purpose: "judge" }).token;
  for (let i = 0; i < 2; i++) {
    const reply = await post(proxy, token, "retry", subject);
    assert.deepEqual(reply, { status: 429, content: '{"error":"run_request_limit"}' });
  }
  assert.equal(forwarded, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "budget.json"), "utf8")).used, 1);
});
