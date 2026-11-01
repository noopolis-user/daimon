import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";

import { gatewayKeyDigest, GATEWAY_KEY_TABLE_VERSION, parseGatewayKeyTable } from "../../../gateway/keyTable.js";
import { createGrokRealmOwner } from "../../../gateway/grokRealmOwner.js";
import { parseGrokAuth, type GrokLogin } from "../../../gateway/grokCredential.js";
import { startGatewayServer } from "../../../gateway/server.js";
import type { PortableRealmAuthority } from "../../../runtime/portableSubscriptionRealmTypes.js";
import { createGrokGatewayAuthority, createGrokGatewayUpstream } from "./grokBrokerGateway.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";
import { startGrokEngineBroker, type GrokEngineBrokerDependencies } from "./grokEngineBroker.js";

const GATEWAY_KEY = "synthetic-broker-gateway-key-0001";
const token = (generation: number): string => `synthetic-grok-access-token-generation-${generation}-xxxxxxxx`;
const login = (generation: number): Buffer => Buffer.from(JSON.stringify({ "https://auth.x.ai::synthetic": { key: token(generation), refresh_token: `synthetic-grok-refresh-${generation}-xx`, expires_at: "2099-01-01T00:00:00Z" } }));
const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const body = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
const answer = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "pong" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`;

type Provider = (authorization: string | undefined, response: ServerResponse) => void;

/** Broker proxy -> real gateway -> fake provider, all on loopback. */
async function chain(t: TestContext, provider: Provider, options: Readonly<{ key?: string; refresh?: (current: GrokLogin) => Promise<GrokLogin> }> = {}) {
  const seen: { url: string; authorization?: string }[] = [];
  const fake = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on("end", () => { seen.push({ url: request.url ?? "", authorization: request.headers.authorization }); provider(request.headers.authorization, response); });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  let stored = login(0);
  let refreshes = 0;
  const realm: PortableRealmAuthority & { staleMarks: number } = {
    staleMarks: 0, read: async () => Buffer.from(stored), replace: async (bytes) => { stored = Buffer.from(bytes); },
    markStale: async () => { realm.staleMarks += 1; }, assertLive: () => undefined
  };
  const owner = await createGrokRealmOwner({ authority: realm, log: () => undefined, refresh: options.refresh ?? (async (current) => { refreshes += 1; return parseGrokAuth(login(Number(/generation-(\d+)/u.exec(current.accessToken)![1]) + 1)); }) });
  const keys = parseGatewayKeyTable({ version: GATEWAY_KEY_TABLE_VERSION, keys: { [gatewayKeyDigest(GATEWAY_KEY)]: { agent_id: "grok-broker", engines: ["grok"] } } });
  const gateway = await startGatewayServer({ keys, grok: { owner, upstreamBaseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1` }, log: () => undefined });
  let gatewayCalls = 0;
  const counting: typeof fetch = (input, init) => { gatewayCalls += 1; return fetch(input, init); };
  const authority = createGrokGatewayAuthority({ url: gateway.url, key: options.key ?? GATEWAY_KEY });
  const proxy = await startGrokBrokerProxy(authority, createGrokGatewayUpstream({ url: gateway.url, key: options.key ?? GATEWAY_KEY }, authority, counting), undefined, 0);
  const meter = new GrokBrokerTurnMeter({ maxRequests: 64, maxTokens: 1_000_000, timeoutMs: 600_000 });
  const capability = proxy.capabilities.issue("agent", "turn");
  proxy.registerIsolationGuard("turn", async () => undefined);
  proxy.registerTurn("turn", { policy: { model: "grok-4.6", reasoningEffort: "low" }, meter });
  t.after(async () => { await proxy.close(); await gateway.close(); await new Promise<void>((resolve) => fake.close(() => resolve())); });
  const send = (): Promise<Readonly<{ status: number; text: string }>> => new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: proxy.port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${capability}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: `${JSON.stringify(response.headers)}\n${Buffer.concat(chunks).toString("utf8")}` }));
    });
    request.on("error", reject); request.end(body);
  });
  return { send, seen, authority, meter, realm, owner, gateway, refreshes: () => refreshes, gatewayCalls: () => gatewayCalls };
}

const ok: Provider = (_authorization, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(answer); };

test("the provider sees the gateway-injected Grok bearer; the broker holds only its gateway key", async (t) => {
  const rig = await chain(t, ok);
  const reply = await rig.send();
  assert.equal(reply.status, 200, reply.text);
  assert.ok(reply.text.endsWith(answer));
  assert.deepEqual(rig.seen, [{ url: "/v1/chat/completions", authorization: `Bearer ${token(0)}` }]);
  assert.equal(await rig.authority.accessToken(false), GATEWAY_KEY);
  assert.ok(!reply.text.includes("synthetic-grok"), "no Grok token byte reaches the broker side");
  assert.deepEqual(rig.meter.snapshot().timings[0]!.usage, { input: 10, cacheRead: 0, cacheWrite: 0, output: 2, total: 12 });
});

test("an upstream 401 is refreshed once inside the gateway; the broker never sees the 401", async (t) => {
  const rig = await chain(t, (authorization, response) => {
    if (authorization === `Bearer ${token(0)}`) { response.writeHead(401); response.end('{"error":"expired"}'); return; }
    ok(authorization, response);
  });
  const reply = await rig.send();
  assert.equal(reply.status, 200, reply.text);
  assert.equal(rig.refreshes(), 1);
  assert.deepEqual(rig.seen.map((entry) => entry.authorization), [`Bearer ${token(0)}`, `Bearer ${token(1)}`]);
  assert.equal(rig.authority.isStale(), false);
  assert.equal(rig.gatewayCalls(), 1);
});

test("gateway auth_stale is the broker's stale path: named refusal, then no further upstream call", async (t) => {
  const rig = await chain(t, (_authorization, response) => { response.writeHead(401); response.end(`{"error":"no","echo":"${token(1)}"}`); });
  const first = await rig.send();
  assert.equal(first.status, 400, first.text);
  assert.match(first.text, /"reason":"auth_stale"/u);
  assert.ok(!first.text.includes("synthetic-grok"));
  assert.equal(rig.authority.isStale(), true);
  assert.equal(rig.realm.staleMarks, 1, "a refreshed bearer refused again fences the gateway realm");
  const second = await rig.send();
  assert.match(second.text, /"reason":"auth_stale"/u);
  assert.equal(rig.gatewayCalls(), 1, "a fenced broker refuses before calling the gateway");
});

test("a gateway 401 is a refused broker key, never a token refresh", async (t) => {
  const rig = await chain(t, ok, { key: "synthetic-broker-gateway-key-WRONG" });
  const reply = await rig.send();
  assert.equal(reply.status, 400, reply.text);
  assert.match(reply.text, /"reason":"gateway_unauthorized"/u);
  assert.equal(rig.refreshes(), 0);
  assert.equal(rig.seen.length, 0);
  assert.equal(rig.authority.isStale(), false);
});

test("upstream 429 and 5xx are relayed to the broker with the token redacted", async (t) => {
  const rig = await chain(t, (_authorization, response) => { response.writeHead(503, { "content-type": "application/json" }); response.end(`{"error":"busy","echo":"${token(0)}"}`); });
  const reply = await rig.send();
  assert.equal(reply.status, 503, reply.text);
  assert.ok(!reply.text.includes(token(0)));
  assert.equal(rig.authority.isStale(), false);
});

function brokerDependencies(events: string[]): GrokEngineBrokerDependencies {
  return {
    acquireLease: async () => { events.push("lease"); return { close: async () => undefined }; },
    createAuthority: () => { events.push("authority"); return { initialize: async () => undefined, accessToken: async () => "unused", markRejected: async () => undefined, isStale: () => false }; },
    startProxy: async (_authority, upstream) => {
      events.push(upstream === undefined ? "proxy:provider" : "proxy:gateway");
      return { port: 43123, close: async () => undefined, capabilities: { issue: () => "provider", revoke() {} }, registerIsolationGuard() {}, revokeIsolationGuard() {}, registerTurn() {}, revokeTurn() {} };
    },
    startMcp: async () => ({ register: () => "mcp", revoke() {}, close: async () => undefined }),
    prepareAttestation: async () => ({ configVariant: "unclocked" as const, dev: 1, ino: 1, size: 0, denyPaths: [] }),
    needsTaskClockReconciliation: async () => false,
    createIsolationGuard: () => async () => undefined,
    writeTaskClock: async () => undefined,
    workerIdentityEmpty: async () => true,
    runNative: async () => { throw new Error("unused"); }
  };
}

const registration = { agentId: "agent", slot: 0, workerUid: 2200, workspace: "/workspace/0", profilePath: "/unused/.grok/sandbox.toml", eventsPath: "/unused/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: "/unused/usage.jsonl", limits: { maxRequests: 2, maxTokens: 100, timeoutMs: 5000 }, model: { model: "grok-4.6", reasoningEffort: "low" } } as const;

test("without a gateway the broker leases its realm and calls the provider exactly as before", async () => {
  const events: string[] = [];
  const broker = await startGrokEngineBroker({ grokCommand: "unused", nativeClient: "unused", credentialHome: "/unused", turnStore: "/unused/turns", registrations: [registration] }, brokerDependencies(events));
  await broker.close();
  assert.deepEqual(events, ["lease", "authority", "proxy:provider"]);
});

test("with a gateway the broker takes no realm lease and builds no credential authority", async () => {
  const events: string[] = [];
  const gatewayFetch: typeof fetch = async (input) => { events.push(`health:${String(input)}`); return new Response(JSON.stringify({ status: "ok", engines: ["grok"] }), { status: 200 }); };
  const broker = await startGrokEngineBroker({ grokCommand: "unused", nativeClient: "unused", credentialHome: "/unused", turnStore: "/unused/turns", registrations: [registration], gateway: { url: "http://127.0.0.1:9", key: GATEWAY_KEY } }, { ...brokerDependencies(events), gatewayFetch });
  assert.equal(broker.readiness().credentialStale, false);
  await broker.close();
  assert.deepEqual(events, ["health:http://127.0.0.1:9/v1/health", "proxy:gateway"]);
});

test("a gateway 502 upstream_unavailable gets the broker's one transport retry", async (t) => {
  let calls = 0;
  const rig = await chain(t, (authorization, response) => {
    calls += 1;
    if (calls === 1) { response.socket?.destroy(); return; }
    ok(authorization, response);
  });
  const reply = await rig.send();
  assert.equal(reply.status, 200, reply.text);
  assert.equal(calls, 2);
  assert.equal(rig.gatewayCalls(), 2);
  assert.equal(rig.meter.snapshot().requests, 2);
});

test("a relayed provider 502 is the provider's answer, not retried", async (t) => {
  const rig = await chain(t, (_authorization, response) => { response.writeHead(502, { "content-type": "application/json" }); response.end('{"error":"bad gateway"}'); });
  const reply = await rig.send();
  assert.equal(reply.status, 502, reply.text);
  assert.equal(rig.gatewayCalls(), 1);
});

test("readiness probes the gateway health route; auth_stale there fences the broker", async (t) => {
  const rig = await chain(t, ok);
  await rig.authority.initialize();
  assert.equal(rig.authority.isStale(), false);
  const wrong = createGrokGatewayAuthority({ url: rig.gateway.url, key: "synthetic-broker-gateway-key-WRONG" });
  await assert.rejects(wrong.initialize());
  assert.equal(wrong.isStale(), false);
  await rig.owner.fence();
  await assert.rejects(rig.authority.initialize());
  assert.equal(rig.authority.isStale(), true);
});
