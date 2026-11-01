import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { PortableRealmAuthority } from "../runtime/portableSubscriptionRealmTypes.js";
import { parseCodexAuth, renderCodexAuth, type CodexTokens } from "./codexCredential.js";
import { createCodexRealmOwner } from "./codexRealmOwner.js";
import { createCodexRefresh } from "./codexRefresh.js";
import { gatewayKeyDigest, GATEWAY_KEY_TABLE_VERSION, parseGatewayKeyTable } from "./keyTable.js";
import { startGatewayServer } from "./server.js";

const AGENT_KEY = "synthetic-gateway-agent-key-0001";
const jwt = (claims: Record<string, unknown>): string => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
const generationTokens = (generation: number): CodexTokens => ({ idToken: jwt({ sub: "synthetic" }), accessToken: jwt({ exp: 4_000_000_000, synthetic_generation: generation }), refreshToken: `synthetic-refresh-${generation}`, accountId: "acct-synthetic" });
const SSE = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}\n\n';

type Seen = { url: string; method: string; authorization?: string; account?: string; rawHeaders: string; body: string };
type UpstreamHandler = (request: Seen, response: ServerResponse, generation: number) => void;

async function fixture(t: import("node:test").TestContext, upstream: UpstreamHandler, token: (response: ServerResponse) => void = (response) => respondToken(response, 1)) {
  const seen: Seen[] = [];
  let tokenCalls = 0;
  const fake = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.url === "/oauth/token") {
        tokenCalls += 1;
        const parsed = JSON.parse(body) as Record<string, unknown>;
        assert.deepEqual(Object.keys(parsed).sort(), ["client_id", "grant_type", "refresh_token", "scope"]);
        setTimeout(() => token(response), 30);
        return;
      }
      const entry: Seen = { url: request.url ?? "", method: request.method ?? "", authorization: request.headers.authorization, account: request.headers["chatgpt-account-id"] as string | undefined, rawHeaders: request.rawHeaders.join("\n"), body };
      seen.push(entry);
      const generation = Number(JSON.parse(Buffer.from(String(entry.authorization).split(".")[1] ?? "", "base64url").toString("utf8") || "{}").synthetic_generation);
      upstream(entry, response, generation);
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  let stored = renderCodexAuth(generationTokens(0));
  const authority: PortableRealmAuthority & { staleMarks: number } = {
    staleMarks: 0,
    read: async () => Buffer.from(stored),
    replace: async (bytes) => { stored = Buffer.from(bytes); },
    markStale: async () => { authority.staleMarks += 1; }
  };
  const logs: string[] = [];
  const owner = await createCodexRealmOwner({ authority, refresh: createCodexRefresh({ tokenUrl: `${base}/oauth/token` }), log: (line) => logs.push(line) });
  const keys = parseGatewayKeyTable({ version: GATEWAY_KEY_TABLE_VERSION, keys: { [gatewayKeyDigest(AGENT_KEY)]: { agent_id: "alpha", engines: ["codex"] } } });
  const gateway = await startGatewayServer({ keys, codex: { owner, upstreamBaseUrl: `${base}/backend-api/codex` }, log: (line) => logs.push(line) });
  t.after(async () => { await gateway.close(); await new Promise<void>((resolve) => fake.close(() => resolve())); });
  const call = async (pathname: string, init: RequestInit = {}, key: string | null = AGENT_KEY) => {
    const response = await fetch(`${gateway.url}${pathname}`, { method: "POST", body: '{"model":"gpt-synthetic"}', ...init, headers: { "content-type": "application/json", ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...(init.headers as Record<string, string> ?? {}) } });
    const text = await response.text();
    const visible = `${response.status}\n${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${text}`;
    for (const generation of [0, 1, 2]) {
      const secret = generationTokens(generation);
      for (const value of [secret.accessToken, secret.refreshToken, secret.idToken]) assert.ok(!visible.includes(value), "a token reached an agent-visible response");
    }
    return { status: response.status, text, headers: response.headers };
  };
  const assertCleanLogs = (): void => {
    for (const line of logs) for (const generation of [0, 1, 2]) for (const value of Object.values(generationTokens(generation))) assert.ok(value === undefined || !line.includes(value));
    for (const line of logs) assert.ok(!line.includes(AGENT_KEY));
  };
  return { seen, gateway, call, authority, logs, assertCleanLogs, tokenCalls: () => tokenCalls, stored: () => parseCodexAuth(stored) };
}

function respondToken(response: ServerResponse, generation: number): void {
  const next = generationTokens(generation);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ access_token: next.accessToken, refresh_token: next.refreshToken, id_token: next.idToken }));
}
const sse = (response: ServerResponse): void => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(SSE); };

test("a bad or missing agent key is 401 and never reaches upstream", async (t) => {
  const f = await fixture(t, (_request, response) => sse(response));
  assert.equal((await f.call("/v1/codex/responses", {}, null)).status, 401);
  assert.equal((await f.call("/v1/codex/responses", {}, "synthetic-wrong-agent-key-9999")).status, 401);
  assert.equal((await f.call("/v1/health", { method: "GET", body: null }, "synthetic-wrong-agent-key-9999")).status, 401);
  assert.equal(f.seen.length, 0);
});

test("paths outside the Codex allowlist are 404", async (t) => {
  const f = await fixture(t, (_request, response) => sse(response));
  for (const [pathname, method] of [["/v1/codex/other", "POST"], ["/v1/codex/responses", "GET"], ["/v1/codex/../models", "GET"], ["/v1/grok/chat/completions", "POST"], ["/backend-api/codex/responses", "POST"], ["/v1/codex/responses/compact/x", "POST"]] as const) {
    assert.equal((await f.call(pathname, method === "GET" ? { method, body: null } : {})).status, 404, `${method} ${pathname}`);
  }
  assert.equal(f.seen.length, 0);
});

test("injects the realm bearer, strips the agent key, streams SSE and counts usage", async (t) => {
  const f = await fixture(t, (_request, response) => sse(response));
  const result = await f.call("/v1/codex/responses", { headers: { originator: "codex_exec", cookie: "synthetic=cookie", "chatgpt-account-id": "acct-forged" } });
  assert.equal(result.status, 200);
  assert.equal(result.text, SSE);
  assert.equal(result.headers.get("content-type"), "text/event-stream");
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0]!.url, "/backend-api/codex/responses");
  assert.equal(f.seen[0]!.authorization, `Bearer ${generationTokens(0).accessToken}`);
  assert.equal(f.seen[0]!.account, "acct-synthetic");
  assert.ok(!f.seen[0]!.rawHeaders.includes(AGENT_KEY), "the agent key reached upstream");
  assert.ok(!/cookie/iu.test(f.seen[0]!.rawHeaders));
  assert.match(f.seen[0]!.rawHeaders, /originator\ncodex_exec/u);
  assert.equal(f.seen[0]!.body, '{"model":"gpt-synthetic"}');
  assert.deepEqual(f.gateway.counters().alpha, { requests: 1, upstreamRequests: 1, refused: 0, responses: 1, inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  const health = await f.call("/v1/health", { method: "GET", body: null });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.text).engines, ["codex"]);
  f.assertCleanLogs();
});

test("an upstream 401 refreshes once and retries with the new bearer", async (t) => {
  const f = await fixture(t, (_request, response, generation) => {
    if (generation === 0) { response.writeHead(401, { "content-type": "application/json" }); response.end('{"error":"expired"}'); return; }
    sse(response);
  });
  const result = await f.call("/v1/codex/responses");
  assert.equal(result.status, 200);
  assert.equal(f.tokenCalls(), 1);
  assert.deepEqual(f.seen.map((entry) => entry.authorization), [`Bearer ${generationTokens(0).accessToken}`, `Bearer ${generationTokens(1).accessToken}`]);
  assert.equal(f.stored().refreshToken, "synthetic-refresh-1", "write-back reached the realm");
  f.assertCleanLogs();
});

test("concurrent upstream 401s share a single refresh", async (t) => {
  const f = await fixture(t, (_request, response, generation) => {
    if (generation === 0) { response.writeHead(401); response.end(); return; }
    sse(response);
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => f.call("/v1/codex/responses")));
  assert.deepEqual(results.map((result) => result.status), Array(8).fill(200));
  assert.equal(f.tokenCalls(), 1);
});

test("a failed refresh answers 403 auth_stale, never a relayed 401", async (t) => {
  const f = await fixture(t, (_request, response) => { response.writeHead(401); response.end(); }, (response) => { response.writeHead(400, { "content-type": "application/json" }); response.end('{"error":"refresh_token_reused"}'); });
  const first = await f.call("/v1/codex/responses");
  assert.equal(first.status, 403);
  assert.deepEqual(JSON.parse(first.text), { error: "auth_stale" });
  assert.equal(f.authority.staleMarks, 1);
  const upstreamCalls = f.seen.length;
  assert.equal((await f.call("/v1/codex/responses")).status, 403);
  assert.equal(f.seen.length, upstreamCalls, "a fenced realm makes no upstream call");
  assert.equal((await f.call("/v1/health", { method: "GET", body: null })).status, 403);
  f.assertCleanLogs();
});

test("a refreshed bearer that is still refused fences the realm", async (t) => {
  const f = await fixture(t, (_request, response) => { response.writeHead(401); response.end(); });
  assert.equal((await f.call("/v1/codex/responses")).status, 403);
  assert.equal(f.tokenCalls(), 1);
  assert.equal(f.authority.staleMarks, 1);
});

test("upstream 429 and 5xx are relayed with a scrubbed, bounded body", async (t) => {
  let status = 429;
  const f = await fixture(t, (request, response) => {
    response.writeHead(status, { "content-type": "application/json", "retry-after": "7" });
    response.end(JSON.stringify({ error: { message: `echo ${request.authorization}` }, pad: "x".repeat(20_000) }));
  });
  const limited = await f.call("/v1/codex/responses");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "7");
  assert.ok(limited.text.length <= 8 * 1024);
  status = 503;
  assert.equal((await f.call("/v1/codex/responses")).status, 503);
  assert.equal(f.tokenCalls(), 0);
});
