import { GrokBrokerRunLimit, type GrokBrokerRunBudget } from "./grokBrokerRunBudget.js";
import { admitWhenIdle } from "./grokBrokerAdmission.js";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { redactCredentialText } from "../../../core/credentialRedaction.js";
import { CLI_ENGINE_MAX_DIAGNOSTIC_BYTES } from "../../../pi/cliChildOutput.js";
import { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { ENGINE_BROKER_AUTH_STALE } from "./engineBrokerProtocol.js";
import { DEFAULT_GROK_BROKER_MODEL_POLICY, parseGrokBrokerModelPolicy, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";
import { authorizeGrokBrokerProxyRequest, GrokBrokerProxyRequestRejection } from "./grokBrokerProxyRequest.js";
import { formatGrokBrokerProxyBodyShape, grokBrokerProxyBodyShape } from "./grokBrokerProxyBodyShape.js";
import { GROK_SESSION_TITLE_SINK_KEY } from "./grokBrokerWorkerConfig.js";
import { parseGrokFinalReply, parseGrokResponseToolNames, parseGrokUpstreamUsage, type GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";
import { GROK_ENGINE_BROKER } from "../../../contracts/runtimeContractManifest.js";
import { serveGrokInferenceGrant } from "./grokInferenceProxy.js";
import type { GrokInferenceGrants } from "./grokInferenceGrants.js";
import { GrokBrokerProviderClockRefusal, type GrokBrokerProviderClock } from "./grokBrokerProviderClock.js";
import { isGrokUpstreamTransportFault } from "./grokBrokerUpstreamFault.js";

/** One running turn as the proxy sees it: its declared model/effort and its spend gate. */
export type GrokBrokerProxyTurn = Readonly<{
  policy: GrokBrokerModelPolicy;
  meter: GrokBrokerTurnMeter;
  clock?: GrokBrokerProviderClock;
}>;

export type GrokBrokerCredentialAuthority = Readonly<{ accessToken(forceRefresh: boolean): Promise<string>; refreshAfterRejection?(rejectedTokenDigest:string):Promise<string>; markRejected(rejectedTokenDigest?:string): Promise<void>; isStale?(): boolean }>;
export type GrokBrokerUpstream = (request: ReturnType<typeof authorizeGrokBrokerProxyRequest>, signal?: AbortSignal) => Promise<Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }>>;

/**
 * `policy` is the fallback declared model/effort (closed list); a registered
 * turn's own policy wins. A request whose turn has no registered meter is
 * refused like one without an isolation guard: nothing is forwarded unmetered.
 * `listenPort` exists for tests that must not contend for the production port.
 *
 * `grants` are evaluator inference grants (`grokInferenceGrants.ts`): a bearer
 * carrying the grant prefix is looked up only there and served by
 * `grokInferenceProxy.ts`; every other bearer is looked up only among turn
 * capabilities. Without `grants` a prefixed bearer is simply refused.
 */
export async function startGrokBrokerProxy(
  authority: GrokBrokerCredentialAuthority, upstream: GrokBrokerUpstream = defaultUpstream,
  policy: GrokBrokerModelPolicy = DEFAULT_GROK_BROKER_MODEL_POLICY, listenPort: number = GROK_ENGINE_BROKER.providerProxy.port,
  grants?: GrokInferenceGrants, runBudget?: GrokBrokerRunBudget
) {
  const handler = createGrokBrokerProxyHandler(authority, upstream, policy, grants, runBudget);
  const server = createServer((request, response) => { void handler.serve(request, response); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return {
    ...handler, port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
      // A worker's idle pooled socket otherwise leaves close() without a bound.
      server.closeAllConnections();
    })
  };
}

/** @internal The production request handler, usable without opening a socket. */
export function createGrokBrokerProxyHandler(
  authority: GrokBrokerCredentialAuthority, upstream: GrokBrokerUpstream = defaultUpstream,
  policy: GrokBrokerModelPolicy = DEFAULT_GROK_BROKER_MODEL_POLICY, grants?: GrokInferenceGrants, runBudget?: GrokBrokerRunBudget
) {
  const admittedUpstream: GrokBrokerUpstream = async (request, signal) => {
    signal?.throwIfAborted();
    await runBudget?.reserve();
    signal?.throwIfAborted();
    return upstream(request, signal);
  };
  const declared = parseGrokBrokerModelPolicy(policy);
  const capabilities = new EngineBrokerCapabilities();
  const guards = new Map<string, () => Promise<void>>();
  const turns = new Map<string, GrokBrokerProxyTurn>();
  return {
    capabilities,
    registerIsolationGuard(turnId: string, guard: () => Promise<void>) { guards.set(turnId, guard); },
    revokeIsolationGuard(turnId: string) { guards.delete(turnId); },
    registerTurn(turnId: string, turn: GrokBrokerProxyTurn) {
      turns.set(turnId, {
        policy: parseGrokBrokerModelPolicy(turn.policy), meter: turn.meter,
        ...(turn.clock === undefined ? {} : { clock: turn.clock })
      });
    },
    revokeTurn(turnId: string) { turns.delete(turnId); },
    serve: (request: IncomingMessage, response: ServerResponse) => serve(
      request, response, authority, admittedUpstream, capabilities, guards, turns, declared, grants
    )
  };
}

/**
 * A refusal the caller must not retry.
 *
 * Every internal refusal used to collapse into one bare 503. Grok treats 503 as
 * transient and blind-retries the same request (observed: 14 retries, ~141k
 * estimated tokens, then `exit 1`), so a policy miss burned a turn's budget and
 * reported itself as an engine crash. Policy refusals now answer 400 with a
 * reason, and only genuinely transient faults keep 503.
 */
export class GrokBrokerProxyRefusal extends Error {
  /**
   * `check` names which body-gate check failed and `detail` is the refused
   * body's content-free shape ({@link grokBrokerProxyBodyShape}); both are for
   * the broker's stderr line, and `check` also rides the 400 body.
   */
  constructor(readonly reason: string, readonly check?: string, readonly detail?: string) { super(`grok broker proxy refused: ${reason}`); }
}

/** A transport retry's fresh admission that did not admit: its client left, or a limit refused it. */
class GrokBrokerRetryNotAdmitted extends Error {
  constructor(readonly outcome: "gone" | Readonly<{ refused: string }>) { super("grok broker proxy retry not admitted"); }
}

async function serve(request: IncomingMessage, response: ServerResponse, authority: GrokBrokerCredentialAuthority, upstream: GrokBrokerUpstream, capabilities: EngineBrokerCapabilities,guards:Map<string,()=>Promise<void>>,turns:Map<string,GrokBrokerProxyTurn>,fallback:GrokBrokerModelPolicy,grants?:GrokInferenceGrants): Promise<void> {
  let settle:((usage:ReturnType<typeof parseGrokUpstreamUsage>,toolCalls?:readonly string[],finalReply?:string)=>void)|undefined;
  let titleSink = false;
  // The turn this request belongs to, once known: every error response it is
  // answered with is noted on that turn's meter, because the worker runs with
  // `max_retries = 0` and that response ends its turn (`grokEngineBrokerTurnEnd.ts`).
  let owner: GrokBrokerProxyTurn | undefined;
  // Every credential this request holds, kept only for this request and only so
  // that a fault's own words can be redacted against them exactly as the CLI
  // child and launcher diagnostics are. Nothing reads them but {@link brokerFaultCause}.
  const secrets: string[] = [];
  try {
    let body = await readBody(request);
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
    titleSink = headers.authorization === `Bearer ${GROK_SESSION_TITLE_SINK_KEY}`;
    const match=headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/u);
    if(match)secrets.push(match[1]!);
    if(match&&match[1]!.startsWith(GROK_ENGINE_BROKER.inferenceGrants.tokenPrefix)){if(!grants)throw new GrokBrokerProxyRefusal("inference_grants_unavailable");return await serveGrokInferenceGrant({method:request.method??"",pathname:new URL(request.url??"/","http://127.0.0.1").pathname,headers,body,token:match[1]!},response,grants,authority,upstream);}
    const scope=match?capabilities.inspectToken(match[1]!):undefined;if(!scope)throw new GrokBrokerProxyRefusal("unknown_capability");const guard=guards.get(scope.turnId),turn=turns.get(scope.turnId);if(!guard||!turn)throw new GrokBrokerProxyRefusal("no_active_turn");
    owner = turn;
    try { await guard(); } catch (error) { throw new GrokBrokerProxyRefusal("worker_isolation_unverified"); }
    // Neutralize engine context before the existing body gate or bearer read.
    // The clock belongs to this turn, never to the slot's installed variant.
    try { if (turn.clock !== undefined) body = Buffer.from(turn.clock.rewrite(body)); }
    catch (error) {
      if (error instanceof GrokBrokerProviderClockRefusal) throw new GrokBrokerProxyRefusal(error.reason);
      throw error;
    }
    // A fenced realm is not a transient fault: the credential is gone until an
    // operator re-logs in, and 503 made Grok blind-retry it (observed: fifteen
    // retries over five minutes, $0 spent, nothing learned). Named, 400, and
    // checked before the credential read, so the miss costs one round trip.
    if (authority.isStale?.() === true) throw new GrokBrokerProxyRefusal(ENGINE_BROKER_AUTH_STALE);
    let token = await authority.accessToken(false);secrets.push(token);const rejectedDigest=createHash("sha256").update(token).digest("hex"); let prepared = authorizeRequestOrRefuse({ method: request.method ?? "", pathname: new URL(request.url ?? "/", "http://127.0.0.1").pathname, headers, body }, capabilities, token, turn.policy ?? fallback); token = "";
    // The spend gate runs after the body is proven a real lean worker request
    // (a refused session-title body never counts) and before any upstream call.
    // A request that meets another still in flight waits for it rather than being
    // refused: one 429 ends the worker's turn (`grokBrokerAdmission.ts`).
    const admission=await admitWhenIdle(turn.meter,response,{ keepFinal: prepared.compaction === true },()=>turns.get(scope.turnId)===turn&&guards.has(scope.turnId));
    if(admission==="gone")return;
    if(admission==="revoked")throw new GrokBrokerProxyRefusal("no_active_turn");
    if("refused" in admission)throw new GrokBrokerRetryNotAdmitted(admission);
    let current = admission;
    const meterAttempt=()=>{settle=(usage,toolCalls,finalReply)=>{turn.meter.settle(current.index,usage,body.byteLength,toolCalls,finalReply);settle=undefined;};};
    meterAttempt();
    // A connection upstream dropped before its response was complete is retried
    // once, as a freshly admitted request: the failed attempt is settled (charged
    // the missing-usage estimate) and the retry re-checks every limit, the run
    // budget and the one-in-flight lane. An HTTP status, an abort or a refusal is
    // never retried (`grokBrokerUpstreamFault.ts`).
    let retried = false;
    const forward = async (outgoing: typeof prepared) => {
      try { return await upstream(outgoing, current.signal); }
      catch (error) {
        if (retried || !isGrokUpstreamTransportFault(error, current.signal)) throw error;
        retried = true;
        process.stderr.write(`[grok-proxy] retrying once: upstream_transport (${brokerFaultCause(error, secrets)})\n`);
        settle?.(undefined);
        // A client that hung up meanwhile has nobody left to read a retried answer.
        if (response.destroyed) throw new GrokBrokerRetryNotAdmitted("gone");
        // A retry that would cross a limit is refused as the transport fault it
        // is (503, `upstream_failed`), never by tripping the limit: a tripped
        // `requests`/`tokens` seals `limit_exceeded`, which Paideia reads as the
        // subject exhausting its own budget.
        if (!turn.meter.hasHeadroom()) throw error;
        const again = await admitWhenIdle(turn.meter, response, { keepFinal: prepared.compaction === true }, () => turns.get(scope.turnId) === turn && guards.has(scope.turnId));
        if (again === "gone") throw new GrokBrokerRetryNotAdmitted("gone");
        if (again === "revoked") throw new GrokBrokerProxyRefusal("no_active_turn");
        if ("refused" in again) throw new GrokBrokerRetryNotAdmitted(again);
        current = again; meterAttempt();
        return upstream(outgoing, current.signal);
      }
    };
    let result = await forward(prepared);
    if (result.status === 401) { token = authority.refreshAfterRejection?await authority.refreshAfterRejection(rejectedDigest):await authority.accessToken(true);secrets.push(token);const refreshedDigest=createHash("sha256").update(token).digest("hex"); prepared = { ...prepared, headers: { ...prepared.headers, authorization: `Bearer ${token}` } }; token = ""; result = await forward(prepared);if(result.status===401)await authority.markRejected(refreshedDigest); }
    // Names only, bounded, and never a reason to fail the request: the response
    // is already buffered here for its usage block, so what the model tried to
    // call is in hand. A decoder fault records no attempt rather than a false
    // empty one, and never disturbs the turn.
    // A successful answer that called nothing and stopped is the turn's final
    // reply: the broker ends a worker that finished but did not exit on it
    // (`grokEngineBrokerTurnEnd.ts`), and reports it when the launcher refused
    // the worker's stdout. Observation only, exactly like the tool names. A
    // compaction summary also calls nothing and stops, and is never the reply.
    settle?.(usageOrEstimate(result.body,result.headers["content-type"]),toolCallsOrNothing(result.body,result.headers["content-type"]),result.status===200&&prepared.compaction!==true?finalReplyOrNothing(result.body,result.headers["content-type"]):undefined);
    if (result.status >= 400) owner.meter.noteFailedResponse("upstream_failed");
    response.writeHead(result.status, { "content-type": result.headers["content-type"] ?? "application/json", "cache-control": "no-store" }); response.end(result.body);
  } catch (error) {
    settle?.(undefined);
    if (error instanceof GrokBrokerRetryNotAdmitted) {
      if (error.outcome === "gone") return;
      owner?.meter.noteFailedResponse("broker_refused");
      response.writeHead(429, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "turn limit reached", limit: error.outcome.refused }));
      return;
    }
    // Every answer below is an error the worker cannot retry, so it ends the
    // worker's turn unless the worker asks again; the broker ends it promptly.
    owner?.meter.noteFailedResponse(isGrokUpstreamTransportFault(error) ? "upstream_failed" : "broker_refused");
    if (error instanceof GrokBrokerRunLimit) {
      response.writeHead(429, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"error":"run_request_limit"}');
      return;
    }
    // Name the refusal on the broker's own stderr (reason code only, never a body
    // or a token) so a failing turn is diagnosable without a stub harness —
    // except for the two requests every healthy turn makes anyway.
    // The request that *discovers* the fence throws an ordinary error from the
    // credential authority, so it is promoted to the same named refusal: one
    // stale realm must not read as one transient fault plus fourteen retries.
    const fenced = !(error instanceof GrokBrokerProxyRefusal) && authority.isStale?.() === true;
    const refused = error instanceof GrokBrokerProxyRefusal || fenced;
    const refusal = error instanceof GrokBrokerProxyRefusal ? error.reason : fenced ? ENGINE_BROKER_AUTH_STALE : "broker_unavailable";
    // A named refusal is its own account; anything else used to reach the log as
    // the bare word `broker_unavailable`, which names nothing — so it carries the
    // fault's own class and message, and nothing else, beside it.
    const named = !refused ? `${refusal} (${brokerFaultCause(error, secrets)})`
      : error instanceof GrokBrokerProxyRefusal && error.check !== undefined ? `${refusal} check=${error.check}${error.detail === undefined ? "" : ` ${error.detail}`}` : refusal;
    if (!titleSink && !expectedWorkerProbe(request)) process.stderr.write(`[grok-proxy] refused: ${named}\n`);
    // Grok's own session-title call is refused by design, and keeps the transient
    // 503 shape it has always had. Forcing 400 and 503 on it were both observed
    // to end the turn `exit=0, result: success`, so the shape is kept because it
    // is the one every live capture was taken with, not because a 4xx there ends
    // Grok's session — it does not.
    if (titleSink) {
      response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"error":"broker unavailable"}');
      return;
    }
    if (refused) {
      response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "broker refused this request", reason: refusal, ...(error instanceof GrokBrokerProxyRefusal && error.check !== undefined ? { check: error.check } : {}) }));
      return;
    }
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"broker unavailable"}');
  } finally { secrets.length = 0; }
}

/**
 * A non-refusal fault, named on one bounded line.
 *
 * `broker_unavailable` on its own carries no diagnostic content at all, and it
 * is answered 503, which Grok blind-retries: one live turn emitted it fifteen
 * times over five minutes, spent $0 — so no upstream call ever succeeded — and
 * died with no account of why. The error's own class and message are the whole
 * of what is logged: never a request body, bearer, capability, session id or
 * header. It is redacted exactly as the failed CLI child and the launcher's
 * worker diagnostic are — `redactCredentialText` with this request's own
 * capabilities as exact secrets and the same `CLI_ENGINE_MAX_DIAGNOSTIC_BYTES`
 * bound — and flattened to one line, because it travels on a log line. Naming
 * a fault must never be able to fail the response that reports it, so a value
 * that cannot even be described degrades to a marker.
 *
 * One level of `cause` is named too, because the fault this exists for names
 * nothing without it: every failed `fetch` to the provider is `TypeError:
 * fetch failed`, and which fault it was — `ENOTFOUND`, `ECONNREFUSED`, a TLS
 * refusal, an abort — is only in the cause. An errno error whose message is
 * empty is named by its `code`.
 */
const brokerFaultCause = (error: unknown, secrets: readonly string[]): string => {
  try {
    const described = `${describeFault(error)}${error instanceof Error && error.cause !== undefined && error.cause !== null ? ` <- ${describeFault(error.cause)}` : ""}`;
    const flattened = described.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
    const named = redactCredentialText(flattened, secrets, CLI_ENGINE_MAX_DIAGNOSTIC_BYTES).trim();
    return named.length === 0 ? "unnamed" : named;
  } catch { return "unnameable"; }
};

/** One value's class and words: an error's own, or the type of whatever else was thrown. */
const describeFault = (error: unknown): string => {
  if (!(error instanceof Error)) return `${typeof error}: ${String(error)}`;
  const code = (error as NodeJS.ErrnoException).code;
  const words = error.message.length > 0 ? error.message : typeof code === "string" ? code : "(no message)";
  return `${error.constructor?.name ?? error.name}: ${words}`;
};

/**
 * The unauthenticated connectivity probe Grok sends before its own requests: a
 * bare `GET /` with no Authorization header, which has no capability to look up
 * and answers 400.
 *
 * It and the per-turn `session_title` POST are the only two requests a healthy
 * turn makes that this proxy does not forward, and both used to print the same
 * `refused: unknown_capability` line as a real policy miss — so every healthy
 * turn read as two refusals and cost a live investigation. They answer exactly
 * as before; they simply stop claiming a refusal on the broker's stderr, which
 * is left for the misses that are actually worth reading.
 */
const expectedWorkerProbe = (request: IncomingMessage): boolean =>
  request.headers.authorization === undefined && (request.method ?? "") === "GET" &&
  new URL(request.url ?? "/", "http://127.0.0.1").pathname === "/";

/**
 * Upstream-reported usage, or the documented conservative estimate.
 *
 * The decoder faulting must not fail the request that already cost real
 * money: the upstream call succeeded, the worker is owed its answer, and a
 * 503 here would throw away a paid response and have Grok buy it again. The
 * `undefined` this returns is not "no usage" — `GrokBrokerTurnMeter.settle`
 * charges it `ceil(bodyBytes/2) + 4096` and marks the row
 * `usage_source: "estimated"`, so the token ceiling still counts it and no
 * fabricated zero ever reaches a ledger.
 */
const usageOrEstimate = (body: Uint8Array, contentType: string | undefined): ReturnType<typeof parseGrokUpstreamUsage> => {
  try { return parseGrokUpstreamUsage(body, contentType); } catch { return undefined; }
};

/** Instrumentation must never fail a turn: a throwing decoder records nothing, exactly as an undecodable response does. */
const toolCallsOrNothing = (body: Uint8Array, contentType: string | undefined): readonly string[] | undefined => {
  try { return parseGrokResponseToolNames(body, contentType); } catch { return undefined; }
};

/** Instrumentation must never fail a turn: a throwing decoder reports no final reply. */
const finalReplyOrNothing = (body: Uint8Array, contentType: string | undefined): string | undefined => {
  try { return parseGrokFinalReply(body, contentType); } catch { return undefined; }
};

/**
 * The body gate, refused non-retryably: a rejected body is a policy miss, never
 * a transient fault. The refusal names the failed check and the body's
 * content-free shape, because a bare `request_body_rejected` sent a live
 * training pilot to a stub harness to learn which of a dozen checks fired.
 */
function authorizeRequestOrRefuse(...args: Parameters<typeof authorizeGrokBrokerProxyRequest>): ReturnType<typeof authorizeGrokBrokerProxyRequest> {
  try { return authorizeGrokBrokerProxyRequest(...args); }
  catch (error) {
    const check = error instanceof GrokBrokerProxyRequestRejection ? error.check : "credential";
    throw new GrokBrokerProxyRefusal("request_body_rejected", check, formatGrokBrokerProxyBodyShape(grokBrokerProxyBodyShape(args[0].body)));
  }
}
async function readBody(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 2 * 1024 * 1024) throw new Error("too large"); chunks.push(value); } return Buffer.concat(chunks); }
const defaultUpstream: GrokBrokerUpstream = async (request, signal) => { const result = await fetch(request.url, { method: "POST", headers: request.headers, body: Buffer.from(request.body), ...(signal === undefined ? {} : { signal }) }); return { status: result.status, headers: { "content-type": result.headers.get("content-type") ?? "application/json" }, body: new Uint8Array(await result.arrayBuffer()) }; };
