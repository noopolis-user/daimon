import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { NativeBrokerTurn, NativeBrokerTurnResult } from "./engineBrokerNativeClient.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { EngineBrokerTurnFailure, runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const leanBody = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
const usage = { prompt_tokens: 2_696, completion_tokens: 79, total_tokens: 2_775, prompt_tokens_details: { cached_tokens: 128 } };
const sse = (chunks: readonly unknown[]): string => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
const toolCall = sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-0", type: "function", function: { name: "use_tool", arguments: "{}" } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }]);
const finalReply = (text: string): string => sse([{ choices: [{ index: 0, delta: { content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }]);
const untilAborted = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => { const fail = () => reject(new Error("engine broker turn failed")); if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true }); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function post(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
    req.on("error", reject); req.end(leanBody);
  });
}

/** One scripted upstream answer per call: an SSE body answered 200, or an HTTP status. */
type Step = string | number;
type Worker = (send: () => Promise<number>, signal: AbortSignal) => Promise<string>;
const timing = { finalGraceMs: 80, idleMs: 30_000, pollMs: 10 };

/** The real proxy, meter, registry and ledgers; the launcher is a scripted worker. The idle bound is far out of reach. */
async function withBroker(steps: readonly Step[], run: (turn: (wakeId: string, worker: Worker) => ReturnType<typeof runGrokEngineBrokerTurn>, ledger: (name: string) => Promise<Record<string, unknown>[]>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-error-end-"));
  let call = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => {
    const step = steps[Math.min(call++, steps.length - 1)]!;
    return typeof step === "number" ? { status: step, headers: { "content-type": "application/json" }, body: Buffer.from('{"error":"broker unavailable"}') } : { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(step) };
  }, undefined, 0);
  const usageLedger = path.join(root, "usage.jsonl");
  try {
    await run((wakeId, worker) => {
      const registration: EngineBrokerServiceRegistration = { agentId: "foreman", slot: 0, workerUid: 2_200, workspace: "/workspace", profilePath: "/workers/0/.grok/sandbox.toml", eventsPath: "/workers/0/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: usageLedger, limits: { maxRequests: 32, maxTokens: 300_000, timeoutMs: 60_000 }, model: { model: "grok-4.6", reasoningEffort: "low" } };
      const deps: GrokEngineBrokerTurnDependencies = {
        turns: new EngineBrokerTurnRegistry(path.join(root, "turns")), proxy, credentialStale: () => false,
        mcp: { register: () => "mcp-capability-0123456789abcdef", revoke: () => undefined, activity: () => ({ inFlight: 0, lastActivityAt: 0 }) },
        workerIdentityEmpty: async () => true, workerReapWaitMs: 2_000,
        prepareIsolation: async () => ({ guard: async () => undefined, configVariant: "unclocked" }),
        observeWorker: async () => ({ pid: 5_151, startTicks: "777" }), observeToolProcess: async () => false, turnEnd: timing,
        runNative: async (input: NativeBrokerTurn, signal: AbortSignal): Promise<NativeBrokerTurnResult> => {
          const text = await worker(() => post(proxy.port, input.providerCapability), signal);
          return { text, workerPid: 4_242, workerUid: 2_200, startTicks: 99n, diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false, exitCode: 0, termSignal: 0, workerPid: 4_242, workerUid: 2_200, startTicks: "99" } };
        }
      };
      return runGrokEngineBrokerTurn(deps, registration, wakeId, "prompt", "http://127.0.0.1:43124/mcp");
    }, async (name) => (await readFile(path.join(root, name), "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>));
  } finally { await proxy.close(); await rm(root, { recursive: true, force: true }); }
}

test("run57: a worker answered with an error that never asks again is ended within the grace and sealed engine_failed/upstream_failed, not timeout", { timeout: 15_000 }, async () => {
  await withBroker([toolCall, 503], async (turn, ledger) => {
    const started = Date.now();
    // Grok logs turn.terminal_failure and handle_prompt.done ok:false, then stays alive and idle.
    const pending = turn("wake-error", async (send, signal) => { assert.equal(await send(), 200); assert.equal(await send(), 503); return untilAborted(signal); });
    await assert.rejects(pending, (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "engine_failed" && error.accounting?.limitReason === "none" && error.accounting.requests === 2);
    // Mutation guard: without the error-response end this waits for the 30 s idle bound and the test times out.
    assert.ok(Date.now() - started < 5_000, `ended after ${Date.now() - started} ms`);
    assert.deepEqual((await ledger("usage.jsonl")).map((row) => [row.outcome, row.reason, row.limit_reason]), [["failed", "upstream_failed", "none"]]);
    // The seal Paideia reads: a closed code, `limit_reason: none`, so never a declared-limit stop.
    assert.deepEqual((await ledger("turns.jsonl")).map((row) => [row.outcome, row.code, row.limit_reason]), [["failed", "engine_failed", "none"]]);
  });
});

test("a worker answered with an error that asks again keeps its turn, even past the grace later on", { timeout: 15_000 }, async () => {
  await withBroker([503, toolCall, finalReply("RECOVERED")], async (turn) => {
    const result = await turn("wake-error-continue", async (send, signal) => {
      assert.equal(await send(), 503);
      await delay(timing.finalGraceMs / 4);
      assert.equal(await send(), 200);
      // A long local tool between requests: quieter than the grace, which must not count from the old error.
      await delay(timing.finalGraceMs * 4);
      if (signal.aborted) return untilAborted(signal);
      assert.equal(await send(), 200);
      return untilAborted(signal);
    });
    // Mutation guard: if a new request does not forget the error, the pause above ends the turn engine_failed.
    assert.deepEqual([result.outcome, result.text, result.requests], ["completed", "RECOVERED", 3]);
  });
});
