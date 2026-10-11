import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { NativeBrokerTurnFailure, type NativeBrokerTurnResult } from "./engineBrokerNativeClient.js";
import { EngineBrokerTurnFailure, runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";
import { createGrokBrokerProxyHandler } from "./grokBrokerProxy.js";

const info = "<user_info>\nOS Version: linux\nToday's date: 2026-10-11\n</user_info>";
const payload = (content: unknown = info, extra: Record<string, unknown> = {}): string => JSON.stringify({
  model: "grok-4.6", reasoning_effort: "low", stream: true,
  messages: [{ role: "user", content }],
  tools: ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({
    type: "function", function: { name }
  })),
  ...extra
});

type Reply = { status: number; body: string };
type Send = (body: string) => Promise<Reply>;
async function post(proxy: ReturnType<typeof createGrokBrokerProxyHandler>, token: string, body: string): Promise<Reply> {
  const request = new IncomingMessage(new Socket());
  request.method = "POST";
  request.url = "/v1/chat/completions";
  request.headers = { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34" };
  request.push(Buffer.from(body));
  request.push(null);
  let status = 0;
  let returned: string | undefined;
  const response = {
    writeHead(code: number) { status = code; },
    end(value: string | Uint8Array) { returned = Buffer.from(value).toString(); }
  } as unknown as ServerResponse;
  await proxy.serve(request, response);
  assert.notEqual(returned, undefined, "handler must finish the response");
  return { status, body: returned! };
}

const nativeResult: NativeBrokerTurnResult = {
  text: [
    { type: "assistant", parent_tool_use_id: null, session_id: "s", message: {
      role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }]
    } },
    { type: "result", subtype: "success", is_error: false, session_id: "s", stop_reason: "end_turn", result: "done" }
  ].map((frame) => JSON.stringify(frame)).join("\n"),
  workerPid: 42, workerUid: 2200, startTicks: 1n,
  diagnostic: {
    status: "ok", stage: "output", failureClass: "none", profileApplied: false,
    exitCode: 0, termSignal: 0, workerPid: 42, workerUid: 2200, startTicks: "1"
  }
};

async function fixture(t: TestContext, act: (send: Send) => Promise<void>, variant: "clocked" | "unclocked" = "clocked") {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-provider-clock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const forwarded: Buffer[] = [];
  const proxy = createGrokBrokerProxyHandler({
    accessToken: async () => "test-provider-token", markRejected: async () => {}
  }, async (request) => {
    forwarded.push(Buffer.from(request.body));
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
    })) };
  });
  const registration: EngineBrokerServiceRegistration = {
    agentId: "agent", slot: 0, workerUid: 2200, workspace: "/workspace",
    profilePath: "/home/.grok/sandbox.toml", eventsPath: "/home/.grok/sessions/sandbox-events.jsonl",
    profileSha256: "a".repeat(64), usageLedgerPath: path.join(root, "usage.jsonl"),
    limits: { maxRequests: 8, maxTokens: 100_000, timeoutMs: 30_000 },
    model: { model: "grok-4.6", reasoningEffort: "low" }
  };
  let launches = 0;
  const deps: GrokEngineBrokerTurnDependencies = {
    turns: new EngineBrokerTurnRegistry(path.join(root, "turns")), proxy,
    mcp: { register: () => "mcp", revoke() {} }, credentialStale: () => false,
    prepareIsolation: async () => ({ configVariant: variant, guard: async () => {} }),
    writeTaskClock: async () => {},
    runNative: async (input) => {
      launches++;
      await act((body) => post(proxy, input.providerCapability, body));
      return nativeResult;
    }
  };
  return {
    forwarded, launches: () => launches,
    run: (wake: string, clock?: string) => runGrokEngineBrokerTurn(
      deps, registration, wake, "work", "http://127.0.0.1:1/mcp", undefined, undefined, clock
    ),
    rows: async (file: string) => (await readFile(path.join(root, file), "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
    record: async (wake: string) => {
      const id = createHash("sha256").update(`agent\0${wake}`).digest("hex");
      const file = createHash("sha256").update(id).digest("hex");
      return JSON.parse(await readFile(path.join(root, "turns", `${file}.json`), "utf8"));
    }
  };
}

test("processClock reaches the proxy, rechecks policy, meters rewritten requests, and seals and replays counts", async (t) => {
  let now = Date.parse("2026-10-11T23:59:59.999Z");
  t.mock.method(Date, "now", () => now);
  // A non-UTC broker must still follow the launcher's pinned UTC timezone.
  const previousTZ = process.env.TZ;
  process.env.TZ = "Pacific/Honolulu";
  t.after(() => { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; });
  const resent = payload([{ type: "text", text: info }], {
    messages: [
      { role: "user", content: [{ type: "text", text: info }] },
      { role: "assistant", content: "history" },
      { role: "user", content: `${info}\ncontinue` }
    ]
  });
  const f = await fixture(t, async (send) => {
    assert.equal((await send(payload())).status, 200);
    now += 2;
    assert.equal((await send(resent)).status, 200);
    assert.equal((await send(payload("no envelope"))).status, 200);
    assert.equal((await send(payload("no date", { reasoning_effort: "high" }))).status, 400);
    assert.equal((await send(payload("no date", { model: "grok-build" }))).status, 400);
    assert.equal((await send(payload("no date", { tools: [] }))).status, 400);
  });
  const first = await f.run("clock", "-0.001");
  assert.equal(JSON.parse(f.forwarded[0]!.toString()).messages[0].content, info);
  assert.deepEqual(JSON.parse(f.forwarded[1]!.toString()), JSON.parse(resent.replaceAll("2026-10-11", "2026-10-12")));
  assert.equal(first.requests, 3);
  assert.equal(first.usage?.total, 30);
  const observed = {
    requests: 6, linesRewritten: 3, requestsWithoutDateLine: 4,
    injectedDate: "2026-10-11", taskDate: "2026-10-12"
  };
  assert.deepEqual(first.providerClock, observed);
  assert.deepEqual((await f.record("clock")).response.providerClock, observed);
  assert.deepEqual((await f.rows("turns.jsonl"))[0].provider_clock, observed);
  assert.equal((await f.rows("requests.jsonl")).length, 3);
  assert.deepEqual(await f.run("clock", "-0.001"), first);
  assert.equal(f.launches(), 1);
  await assert.rejects(f.run("clock", "+0.001"), /conflict/u);
});

test("unclocked requests are byte-identical and have no provider-clock observation", async (t) => {
  const raw = ` \n${JSON.stringify(JSON.parse(payload(info.replace("2026-10-11", "October 11, 2026"))), null, 2)}\n`;
  const f = await fixture(t, async (send) => { assert.equal((await send(raw)).status, 200); });
  const result = await f.run("real");
  assert.deepEqual(f.forwarded, [Buffer.from(raw)]);
  assert.equal(Object.hasOwn(result, "providerClock"), false);
  assert.equal(Object.hasOwn((await f.rows("turns.jsonl"))[0], "provider_clock"), false);
});

test("unrecognized date format is a distinct refusal with no spend, sealed on failure and replay", async (t) => {
  const f = await fixture(t, async (send) => {
    const refused = await send(payload(info.replace("2026-10-11", "October 11, 2026")));
    assert.equal(refused.status, 400);
    assert.equal(JSON.parse(refused.body).reason, "task_clock_date_format");
    throw new Error("worker failed after refusal");
  });
  const observed = {
    requests: 1, linesRewritten: 0, requestsWithoutDateLine: 0, injectedDate: null, taskDate: null
  };
  for (let replay = 0; replay < 2; replay++) {
    await assert.rejects(f.run("bad", "+0"), (error: unknown) => {
      assert.ok(error instanceof EngineBrokerTurnFailure);
      assert.deepEqual(error.providerClock, observed);
      assert.equal(error.accounting?.requests, 0);
      return true;
    });
  }
  assert.deepEqual(f.forwarded, []);
  assert.equal(f.launches(), 1);
  assert.deepEqual((await f.rows("turns.jsonl"))[0].provider_clock, observed);
  assert.deepEqual((await f.record("bad")).response.providerClock, observed);
});

test("final-reply recovery seals the observation, including a clock requested in an unclocked slot", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-11T00:00:00Z"));
  t.mock.method(console, "warn", () => {});
  const f = await fixture(t, async (send) => {
    assert.equal((await send(payload())).status, 200);
    throw new NativeBrokerTurnFailure({
      ...nativeResult.diagnostic, status: "output_failed", failureClass: "output_limit"
    });
  }, "unclocked");
  const result = await f.run("recovered", "-0.001");
  assert.equal(result.outcome, "completed");
  assert.equal(result.shellClock, "gap");
  assert.equal(result.providerClock?.taskDate, "2026-10-10");
  assert.equal(result.providerClock?.linesRewritten, 1);
  assert.deepEqual((await f.rows("turns.jsonl"))[0].provider_clock, result.providerClock);
});
