import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { GrokWorkerConfigVariant } from "../contracts/grokBrokerTaskClock.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";
import { writeBrokerTaskClock } from "./grokBrokerTaskClock.js";

async function fixture(t: TestContext, configVariant: GrokWorkerConfigVariant = "clocked") {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "clock"), file = path.join(directory, "faketime");
  await mkdir(directory); await chmod(directory, 0o755);
  const registration: EngineBrokerServiceRegistration = { agentId: "agent", slot: 0, workerUid: 2200, workspace: "/workspace", profilePath: "/home/.grok/sandbox.toml", eventsPath: "/home/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: path.join(root, "usage.jsonl"), limits: { maxRequests: 2, maxTokens: 100, timeoutMs: 1000 }, model: { model: "grok-4.6", reasoningEffort: "low" } };
  const events: string[] = [];
  const deps: GrokEngineBrokerTurnDependencies = {
    turns: new EngineBrokerTurnRegistry(path.join(root, "turns")), credentialStale: () => false,
    proxy: { capabilities: { issue: () => "provider", revoke() {} }, registerIsolationGuard() {}, revokeIsolationGuard() {}, registerTurn() {}, revokeTurn() {} },
    mcp: { register: () => "mcp", revoke() {} },
    prepareIsolation: async () => { events.push("attest"); return { configVariant, guard: async () => {} }; },
    writeTaskClock: async (value) => { await writeBrokerTaskClock(value, file, process.getuid!()); events.push(`write:${value ?? "+0"}`); },
    runNative: async () => {
      events.push(configVariant === "clocked" ? `launch:${(await readFile(file, "utf8")).trim()}` : "launch");
      const text = [
        { type: "assistant", parent_tool_use_id: null, session_id: "s", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } },
        { type: "result", subtype: "success", is_error: false, session_id: "s", stop_reason: "end_turn", result: "done" }
      ].map((frame) => JSON.stringify(frame)).join("\n");
      return { text, workerPid: 42, workerUid: 2200, startTicks: 1n, diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false, exitCode: 0, termSignal: 0, workerPid: 42, workerUid: 2200, startTicks: "1" } };
    }
  };
  return { deps, events, file, turn: (wake: string, clock?: string) => runGrokEngineBrokerTurn(deps, registration, wake, "work", "http://127.0.0.1:1/mcp", undefined, undefined, clock),
    seals: async () => (await readFile(path.join(root, "turns.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

test("each turn attests, atomically publishes its exact value, then launches; replay does not write", async (t) => {
  const f = await fixture(t);
  const warning = t.mock.method(console, "warn", () => {});
  const first = await f.turn("one", "-843385600.250");
  assert.equal(first.shellClock, "task");
  assert.equal((await f.turn("two")).shellClock, "real");
  assert.deepEqual(f.events, ["attest", "write:-843385600.250", "launch:-843385600.250", "attest", "write:+0", "launch:+0"]);
  assert.deepEqual((await f.seals()).map((row) => row.shell_clock), ["task", "real"]);
  assert.deepEqual(await f.turn("one", "-843385600.250"), first);
  assert.equal(f.events.length, 6);
  assert.equal(await readFile(f.file, "utf8"), "+0\n", "replay must not change the current slot clock");
  await assert.rejects(f.turn("one", "+1"), /conflict/u);
  await assert.rejects(f.turn("one"), /conflict/u);
  assert.equal(warning.mock.callCount(), 0);
});

test("unclocked worker retains production behavior and seals its clock coverage gap", async (t) => {
  const f = await fixture(t, "unclocked");
  const warning = t.mock.method(console, "warn", () => {});
  assert.equal((await f.turn("clock", "+1.234")).shellClock, "gap");
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(f.events, ["attest", "launch"]);
  assert.equal((await f.seals())[0].shell_clock, "gap");
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("a failed clock publication prevents native launch and cannot claim clocked children", async (t) => {
  const f = await fixture(t);
  const deps = f.deps as { writeTaskClock: NonNullable<GrokEngineBrokerTurnDependencies["writeTaskClock"]> };
  deps.writeTaskClock = async () => { throw new Error("write failed"); };
  await assert.rejects(f.turn("fail", "+1"), /engine broker turn failed/u);
  assert.deepEqual(f.events, ["attest"]);
  assert.equal((await f.seals())[0].shell_clock, undefined);
});
