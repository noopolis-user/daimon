import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { redactCredentialText } from "../core/credentialRedaction.js";
import { CodexAuthStale, CodexRealmLost, type CodexBearer, type CodexRealmOwner } from "./codexRealmOwner.js";
import type { GatewayKeyEntry, GatewayKeyTable } from "./keyTable.js";
import { createUsageTap, GATEWAY_LIMITS, readBoundedText, readRequestBody, relayResponseHeaders, RequestTooLarge, upstreamRequestHeaders } from "./relay.js";

export const CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** The only Codex routes a key can buy; there is no open proxy. */
export const CODEX_GATEWAY_ROUTES = Object.freeze(["POST /responses", "POST /responses/compact", "GET /models"] as const);

export type GatewayAgentCounters = { requests: number; upstreamRequests: number; refused: number; responses: number; inputTokens: number; outputTokens: number; totalTokens: number };
export type GatewayServer = Readonly<{
  url: string;
  port: number;
  counters(): Readonly<Record<string, Readonly<GatewayAgentCounters>>>;
  close(): Promise<void>;
}>;
export type GatewayServerOptions = Readonly<{
  host?: string;
  port?: number;
  keys: GatewayKeyTable;
  codex: Readonly<{ owner: CodexRealmOwner; upstreamBaseUrl?: string }>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}>;

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function startGatewayServer(options: GatewayServerOptions): Promise<GatewayServer> {
  const fetcher = options.fetch ?? fetch;
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const upstreamBase = (options.codex.upstreamBaseUrl ?? CODEX_UPSTREAM_BASE_URL).replace(/\/+$/u, "");
  const owner = options.codex.owner;
  const counters = new Map<string, GatewayAgentCounters>();
  const lifetime = new AbortController();
  let active = 0;

  const countersFor = (agentId: string): GatewayAgentCounters => {
    let value = counters.get(agentId);
    if (value === undefined) counters.set(agentId, value = { requests: 0, upstreamRequests: 0, refused: 0, responses: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    return value;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const presented = bearerToken(request.headers.authorization);
    const entry = options.keys.lookup(presented);
    if (entry === undefined) return refuse(request, response, 401, "unauthorized");
    const agent = countersFor(entry.agentId);
    agent.requests += 1;
    const url = new URL(request.url ?? "/", "http://gateway.invalid");
    if (url.pathname === "/v1/health" && request.method === "GET" && url.search === "") return health(response, entry, agent);
    if (!url.pathname.startsWith("/v1/codex/")) return refuse(request, response, 404, "not_found", agent);
    const subpath = url.pathname.slice("/v1/codex".length);
    if (!(CODEX_GATEWAY_ROUTES as readonly string[]).includes(`${request.method} ${subpath}`)) return refuse(request, response, 404, "not_found", agent);
    if (!entry.engines.includes(ENGINE_DESCRIPTORS.codex.id)) return refuse(request, response, 403, "engine_not_allowed", agent);
    if (active >= GATEWAY_LIMITS.maxConcurrentRequests) return refuse(request, response, 503, "overloaded", agent, { "retry-after": "1" });
    active += 1;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    response.once("close", abort);
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    try {
      const body = request.method === "POST" ? await readRequestBody(request) : Buffer.alloc(0);
      await relayCodex(request, response, body, `${upstreamBase}${subpath}${url.search}`, agent, presented!, signal);
    } catch (error) {
      if (error instanceof Refusal) return refuse(request, response, error.status, error.code, agent);
      if (error instanceof RequestTooLarge) return refuse(request, response, 413, "request_too_large", agent);
      if (error instanceof CodexAuthStale) return refuse(request, response, 403, "auth_stale", agent);
      if (error instanceof CodexRealmLost) return refuse(request, response, 503, "realm_unavailable", agent);
      log(`daimon gateway: codex relay failed (${error instanceof Error ? error.name : "unknown"})`);
      if (!response.headersSent) return refuse(request, response, 502, "upstream_unavailable", agent);
      response.destroy();
    } finally {
      active -= 1;
      response.off("close", abort);
    }
  };

  const relayCodex = async (
    request: IncomingMessage, response: ServerResponse, body: Buffer, target: string,
    agent: GatewayAgentCounters, agentKey: string, signal: AbortSignal
  ): Promise<void> => {
    let bearer: CodexBearer = await owner.bearer();
    for (let attempt = 0; ; attempt += 1) {
      const headers = upstreamRequestHeaders(request.headers);
      headers.authorization = `Bearer ${bearer.accessToken}`;
      if (bearer.accountId !== undefined) headers["chatgpt-account-id"] = bearer.accountId;
      const headerTimeout = new AbortController();
      const timer = setTimeout(() => headerTimeout.abort(), GATEWAY_LIMITS.upstreamHeadersMs);
      agent.upstreamRequests += 1;
      let upstream: Response;
      try {
        upstream = await fetcher(target, {
          method: request.method, headers, redirect: "manual", signal: AbortSignal.any([signal, headerTimeout.signal]),
          ...(request.method === "POST" ? { body: new Uint8Array(body) } : {})
        });
      } catch {
        throw headerTimeout.signal.aborted ? new Refusal(504, "upstream_timeout") : new Refusal(502, "upstream_unavailable");
      } finally {
        clearTimeout(timer);
      }
      if (upstream.status === 401) {
        await upstream.body?.cancel().catch(() => undefined);
        if (attempt > 0) { await owner.fence(); throw new CodexAuthStale(); }
        bearer = await owner.rejected(bearer);
        continue;
      }
      if (!upstream.ok) {
        // 429 and 5xx keep their status; the body is bounded and scrubbed of every secret.
        const text = await readBoundedText(upstream.body, GATEWAY_LIMITS.errorBodyBytes);
        response.writeHead(upstream.status, relayResponseHeaders(upstream.headers));
        response.end(redactCredentialText(text, [...owner.secrets(), agentKey], GATEWAY_LIMITS.errorBodyBytes));
        agent.responses += 1;
        return;
      }
      response.writeHead(upstream.status, relayResponseHeaders(upstream.headers));
      await streamBody(upstream.body, response, signal, createUsageTap((usage) => {
        agent.inputTokens += usage.inputTokens; agent.outputTokens += usage.outputTokens; agent.totalTokens += usage.totalTokens;
      }));
      agent.responses += 1;
      return;
    }
  };

  const health = (response: ServerResponse, entry: GatewayKeyEntry, agent: GatewayAgentCounters): void => {
    const codex = entry.engines.includes(ENGINE_DESCRIPTORS.codex.id);
    const realms: Record<string, "ready" | "stale" | "unavailable"> = {};
    const writeBack: Record<string, "ok" | "pending"> = {};
    if (codex) {
      realms[ENGINE_DESCRIPTORS.codex.id] = !owner.live() ? "unavailable" : owner.stale() ? "stale" : "ready";
      writeBack[ENGINE_DESCRIPTORS.codex.id] = owner.writeBackPending() ? "pending" : "ok";
    }
    const body = { agent_id: entry.agentId, engines: entry.engines, realms, write_back: writeBack };
    const states = Object.values(realms);
    if (states.includes("stale")) { agent.refused += 1; return json(response, 403, { error: "auth_stale", ...body }); }
    if (states.includes("unavailable")) { agent.refused += 1; return json(response, 503, { error: "realm_unavailable", ...body }); }
    // A refreshed login not yet durable in the realm would be lost on restart: not ready until it lands.
    if (Object.values(writeBack).includes("pending")) { agent.refused += 1; return json(response, 503, { error: "write_back_pending", ...body }); }
    json(response, 200, { status: "ok", ...body, usage: { ...agent } });
  };

  const refuse = (request: IncomingMessage, response: ServerResponse, status: number, code: string, agent?: GatewayAgentCounters, headers: Record<string, string> = {}): void => {
    if (agent !== undefined) agent.refused += 1;
    request.resume();
    if (response.headersSent) { response.destroy(); return; }
    json(response, status, { error: code }, headers);
  };

  const server = createServer((request, response) => { void handle(request, response).catch(() => response.destroy()); });
  server.requestTimeout = GATEWAY_LIMITS.requestReadMs;
  server.headersTimeout = GATEWAY_LIMITS.headersTimeoutMs;
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("gateway did not bind a TCP port");
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    counters: () => Object.fromEntries([...counters].map(([id, value]) => [id, { ...value }])),
    close: () => closing ??= new Promise<void>((resolve) => {
      lifetime.abort();
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    })
  };
}

async function streamBody(body: ReadableStream<Uint8Array> | null, response: ServerResponse, signal: AbortSignal, tap: (chunk: Uint8Array) => void): Promise<void> {
  if (body === null) { response.end(); return; }
  const reader = body.getReader();
  let size = 0;
  let stalled = false;
  let idle: NodeJS.Timeout | undefined;
  const arm = (): void => { clearTimeout(idle); idle = setTimeout(() => { stalled = true; void reader.cancel().catch(() => undefined); }, GATEWAY_LIMITS.streamIdleMs); };
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    arm();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > GATEWAY_LIMITS.responseBytes) throw new Error("response too large");
      arm();
      tap(next.value);
      if (!response.write(next.value)) await new Promise<void>((resolve) => { response.once("drain", resolve); response.once("close", resolve); });
    }
    if (stalled || signal.aborted) throw new Error("stream ended early");
    response.end();
  } finally {
    clearTimeout(idle);
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
  }
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/u.exec(header ?? "");
  return match?.[1];
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(`${JSON.stringify(value)}\n`);
}
