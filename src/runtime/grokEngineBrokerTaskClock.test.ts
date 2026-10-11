import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { GrokWorkerConfigVariant } from "../contracts/grokBrokerTaskClock.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";
import { writeBrokerTaskClock, type BrokerTaskClockFs } from "./grokBrokerTaskClock.js";

async function fixture(t: TestContext, configVariant: GrokWorkerConfigVariant = "clocked") {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "clock"), file = path.join(directory, "faketime");
  await mkdir(directory); await chmod(directory, 0o755);
  if (configVariant === "clocked") await writeFile(file, "+888\n");
  const registration: EngineBrokerServiceRegistration = { agentId: "agent", slot: 0, workerUid: 2200, workspace: "/workspace", profilePath: "/home/.grok/sandbox.toml", eventsPath: "/home/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: path.join(root, "usage.jsonl"), limits: { maxRequests: 2, maxTokens: 100, timeoutMs: 1000 }, model: { model: "grok-4.6", reasoningEffort: "low" } };
  const events: string[] = [];
  const deps: GrokEngineBrokerTurnDependencies = {
    turns: new EngineBrokerTurnRegistry(path.join(root, "turns")), credentialStale: () => false,
    clockedSlot: configVariant === "clocked", workerIdentityEmpty: async () => true,
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
      events.push("terminated");
      return { text, workerPid: 42, workerUid: 2200, startTicks: 1n, diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false, exitCode: 0, termSignal: 0, workerPid: 42, workerUid: 2200, startTicks: "1" } };
    }
  };
  return { deps, events, file,
    turn: (wake: string, clock?: string, overrides: Partial<GrokEngineBrokerTurnDependencies> = {}, signal?: AbortSignal) =>
      runGrokEngineBrokerTurn(
        { ...deps, ...overrides }, registration, wake, "work", "http://127.0.0.1:1/mcp", signal, undefined, clock
      ),
    seals: async () => (await readFile(path.join(root, "turns.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

test("each turn attests, atomically publishes its exact value, then launches; replay does not write", async (t) => {
  const f = await fixture(t);
  const warning = t.mock.method(console, "warn", () => {});
  const first = await f.turn("one", "-843385600.250");
  assert.equal(first.shellClock, "task");
  assert.equal((await f.turn("two")).shellClock, "real");
  assert.deepEqual(f.events, [
    "attest", "write:-843385600.250", "launch:-843385600.250", "terminated", "write:+0",
    "attest", "write:+0", "launch:+0", "terminated", "write:+0"
  ]);
  assert.deepEqual((await f.seals()).map((row) => row.shell_clock), ["task", "real"]);
  assert.deepEqual(await f.turn("one", "-843385600.250"), first);
  assert.equal(f.events.length, 10);
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
  assert.deepEqual(f.events, ["attest", "launch", "terminated"]);
  assert.equal((await f.seals())[0].shell_clock, "gap");
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

for (const failure of ["file-sync", "directory-sync"] as const) {
  test(`a ${failure} publication failure clears a pre-existing offset without launching`, async (t) => {
    const f = await fixture(t);
    let injected = false;
    const fs: BrokerTaskClockFs = {
      lstat, rename, unlink,
      open: async (...args) => {
        const handle = await open(...args);
        const directory = (await handle.stat()).isDirectory();
        const sync = handle.sync.bind(handle);
        t.mock.method(handle, "sync", async () => {
          if (!injected && directory === (failure === "directory-sync")) {
            injected = true;
            assert.equal(await readFile(f.file, "utf8"), directory ? "-1.234\n" : "+888\n");
            throw new Error("injected sync failure");
          }
          await sync();
        });
        return handle;
      }
    };
    await assert.rejects(f.turn("fail", "-1.234", {
      clockedSlot: false, // Per-turn attestation can discover a newly installed clocked config.
      writeTaskClock: (value) => writeBrokerTaskClock(value, f.file, process.getuid!(), fs)
    }), /engine broker turn failed/u);
    assert.equal(injected, true, "the requested fsync must actually run");
    assert.deepEqual(f.events, ["attest"]);
    assert.equal(await readFile(f.file, "utf8"), "+0\n");
    assert.equal((await f.seals())[0].shell_clock, undefined);
  });
}

for (const ending of ["success", "failure", "cancellation", "timeout"] as const) {
  for (const clock of ["-1.234", undefined]) {
    test(`${ending} resets a stale file after worker termination (${clock ?? "unclocked turn"})`, async (t) => {
      const f = await fixture(t);
      assert.equal(await readFile(f.file, "utf8"), "+888\n");
      const caller = new AbortController();
      let terminated = false;
      let reaped = false;
      let polls = 0;
      const offset = `${clock ?? "+0"}\n`;
      const pending = f.turn("terminal", clock, {
        runNative: async (input, signal) => {
          assert.equal(await readFile(f.file, "utf8"), offset);
          if (ending === "cancellation") caller.abort();
          if (ending === "timeout") {
            await new Promise<void>((resolve) => {
              // Real native sockets keep the loop alive; the broker timer is unref'ed.
              const deadline = setTimeout(resolve, 2000);
              const aborted = () => { clearTimeout(deadline); resolve(); };
              if (signal.aborted) aborted();
              else signal.addEventListener("abort", aborted, { once: true });
            });
          }
          // Native transport settles before the remote worker reaper finishes.
          terminated = true;
          if (ending !== "success") throw new Error(ending);
          return f.deps.runNative(input, signal);
        },
        workerIdentityEmpty: async () => {
          assert.equal(terminated, true);
          assert.equal(await readFile(f.file, "utf8"), offset, "no reset while the worker may survive");
          reaped = ++polls > 1;
          return reaped;
        },
        writeTaskClock: async (value) => {
          if (terminated) assert.equal(reaped, true, "cleanup follows the worker reap");
          await f.deps.writeTaskClock!(value);
        }
      }, caller.signal);
      if (ending === "success") assert.equal((await pending).outcome, "completed");
      else await assert.rejects(pending, /engine broker turn failed/u);
      assert.ok(polls > 1);
      assert.equal(await readFile(f.file, "utf8"), "+0\n");
      assert.equal(f.events.at(-1), "write:+0");
      assert.equal((await f.seals())[0].outcome, ending === "success" ? "completed" : "failed");
      if (ending === "timeout") assert.equal((await f.seals())[0].limit_reason, "timeout");
    });
  }
}

test("failed per-turn attestation still resets the startup-attested clocked slot", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.turn("attestation", "-1", {
    prepareIsolation: async () => { throw new Error("attestation unavailable"); }
  }), /engine broker turn failed/u);
  assert.equal(await readFile(f.file, "utf8"), "+0\n");
  assert.deepEqual(f.events, ["write:+0"]);
});

test("an unreaped worker fences the slot without changing a live shell's clock", async (t) => {
  const f = await fixture(t);
  let fenced = false;
  await assert.rejects(f.turn("unreaped", "-1", {
    runNative: async () => { throw new Error("native transport lost"); },
    workerIdentityEmpty: async () => false,
    workerReapWaitMs: 0,
    taskClockFailed: () => { fenced = true; }
  }), /task clock cleanup failed; restart required/u);
  assert.equal(fenced, true);
  assert.equal(await readFile(f.file, "utf8"), "-1\n");
});
