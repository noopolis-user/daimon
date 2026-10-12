import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";
import type { GrokWorkerConfigVariant } from "../contracts/grokBrokerTaskClock.js";
import {
  EngineBrokerTurnFailure, startGrokEngineBroker, type GrokEngineBrokerDependencies, type GrokEngineBrokerRegistration
} from "./grokEngineBroker.js";
import type { GrokBrokerProviderClockObservation } from "./grokBrokerProviderClock.js";
import { needsBrokerTaskClockReconciliation, writeBrokerTaskClock } from "./grokBrokerTaskClock.js";
import { renderGrokBrokerWorkerConfig } from "./grokBrokerWorkerConfig.js";
import { EngineBrokerControlClient } from "./engineBrokerControlClient.js";
import {
  EngineBrokerFrameDecoder, parseEngineBrokerResponse, type EngineBrokerResponse
} from "./engineBrokerProtocol.js";
import { serveEngineBrokerConnection, type EngineBrokerServiceEngine } from "./engineBrokerService.js";

// Production service/client framing and parsing; only the Unix transport is replaced.
function clientFor(broker: EngineBrokerServiceEngine, frames: EngineBrokerResponse[]) {
  return new EngineBrokerControlClient("memory", () => {
    const socket = new Duplex({ read() {} });
    const peer = new Duplex({ read() {} });
    socket._write = (chunk, _encoding, done) => {
      peer.push(chunk);
      done();
    };
    peer._write = (chunk, _encoding, done) => {
      socket.push(chunk);
      done();
    };
    socket._final = (done) => {
      peer.push(null);
      done();
    };
    peer._final = (done) => {
      socket.push(null);
      done();
    };
    socket.once("close", () => peer.destroy());
    peer.once("close", () => socket.destroy());
    const decoder = new EngineBrokerFrameDecoder();
    socket.on("data", (chunk) => frames.push(...decoder.push(chunk).map(parseEngineBrokerResponse)));
    serveEngineBrokerConnection(peer as Socket, broker);
    queueMicrotask(() => socket.emit("connect"));
    return socket as Socket;
  });
}

async function fixture(t: TestContext, count = 1, variant: GrokWorkerConfigVariant = "clocked", clockDirectory = variant === "clocked") {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-start-"));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "task-clock", "faketime");
  if (clockDirectory) {
    await mkdir(path.dirname(file), { mode: 0o755 });
    await writeFile(file, "+888\n");
  }
  const events: string[] = [];
  const dependencies: GrokEngineBrokerDependencies = {
    acquireLease: async () => {
      events.push("lease");
      return { close: async () => { events.push("lease:close"); } };
    },
    createAuthority: () => ({
      initialize: async () => { events.push("authority"); },
      accessToken: async () => "unused", markRejected: async () => {}, isStale: () => false
    }),
    prepareAttestation: async () => {
      events.push(`attest:${variant}`);
      return { configVariant: variant, dev: 1, ino: 1, size: 0, denyPaths: [] };
    },
    needsTaskClockReconciliation: (profilePath, pins) => needsBrokerTaskClockReconciliation(profilePath, pins, file),
    createIsolationGuard: () => async () => {},
    workerIdentityEmpty: async () => {
      events.push("reap");
      return true;
    },
    writeTaskClock: async (value) => {
      events.push(`write:${value ?? "+0"}`);
      await writeBrokerTaskClock(value, file, process.getuid!());
    },
    startProxy: async () => {
      events.push(`proxy:${(await readFile(file, "utf8").catch(() => "absent")).trim()}`);
      return {
        port: 43123, close: async () => { events.push("proxy:close"); },
        capabilities: { issue: () => "provider", revoke() {} },
        registerIsolationGuard() {}, revokeIsolationGuard() {}, registerTurn() {}, revokeTurn() {}
      };
    },
    startMcp: async () => ({ register: () => "mcp", revoke() {}, close: async () => {} }),
    runNative: async () => {
      events.push("launch");
      throw new Error("simulated native failure");
    }
  };
  const registrations: GrokEngineBrokerRegistration[] = Array.from({ length: count }, (_, index) => ({
    agentId: `agent-${index}`, slot: index, workerUid: 2200 + index, workspace: `/workspace/${index}`,
    profilePath: path.join(root, `home-${index}`, ".grok", "sandbox.toml"),
    eventsPath: path.join(root, `home-${index}`, ".grok", "sessions", "sandbox-events.jsonl"), profileSha256: "a".repeat(64),
    usageLedgerPath: path.join(root, `usage-${index}.jsonl`),
    limits: { maxRequests: 2, maxTokens: 100, timeoutMs: 5000 },
    model: { model: "grok-4.6", reasoningEffort: "low" }
  }));
  const provisionConfig = async () => {
    for (const registration of registrations) {
      await mkdir(path.dirname(registration.profilePath), { recursive: true });
      await writeFile(path.join(path.dirname(registration.profilePath), "config.toml"),
        renderGrokBrokerWorkerConfig(registration.model, variant));
    }
  };
  await provisionConfig();
  return {
    file, events, dependencies, registrations,
    record: async () => {
      const directory = path.join(root, "turns", "slot-0");
      const files = await readdir(directory);
      assert.equal(files.length, 1, "only the admitted turn may have a record");
      return readFile(path.join(directory, files[0]!), "utf8");
    },
    async variant(value: GrokWorkerConfigVariant) { variant = value; await provisionConfig(); },
    start: async (overrides: Partial<GrokEngineBrokerDependencies> = {}) => {
      const broker = await startGrokEngineBroker({
        grokCommand: "unused", nativeClient: "unused", credentialHome: root,
        turnStore: path.join(root, "turns"), registrations
      }, { ...dependencies, ...overrides });
      t.after(() => broker.close());
      return broker;
    }
  };
}

test("production startup reconciles a stale clock after leasing and reaping, before serving", async (t) => {
  const f = await fixture(t);
  const broker = await f.start();
  assert.equal(await readFile(f.file, "utf8"), "+0\n");
  const written = f.events.indexOf("write:+0");
  assert.ok(written > f.events.indexOf("lease"));
  assert.ok(written > f.events.lastIndexOf("reap"));
  assert.ok(f.events.indexOf("proxy:+0") > written);
  await broker.close();
  // A killed broker cannot run finally: restart must reconcile its persisted offset.
  await writeFile(f.file, "-444.123\n");
  await f.start();
  assert.equal(await readFile(f.file, "utf8"), "+0\n");
});

for (const provisioning of ["pinned", "missing", "invalid"] as const) {
  test(`unclocked ${provisioning} provisioning cannot make startup depend on attestation`, async (t) => {
    const f = await fixture(t, 2, "unclocked");
    const config = path.join(path.dirname(f.registrations[0]!.profilePath), "config.toml");
    if (provisioning === "missing") await rm(config);
    if (provisioning === "invalid") await writeFile(config, "invalid config");
    let attestations = 0;
    const broker = await f.start({ prepareAttestation: async () => {
      attestations++;
      throw new Error("mis-provisioned unclocked worker");
    } });
    assert.equal(attestations, 0, "unclocked startup must not run full worker attestation");
    assert.equal(broker.readiness().registrations, 2);
    assert.equal(broker.readiness().workerIsolation, true);
    assert.deepEqual(f.events, ["lease", "authority", "proxy:absent"]);
    await assert.rejects(broker.turn("agent-0", "bad", "work", "http://127.0.0.1:1/mcp"), /engine broker turn failed/u);
    assert.equal(attestations, 1, "the mis-provisioned worker still fails its own turn");
    assert.equal(f.events.includes("launch"), false);
    assert.equal(f.events.includes("lease:close"), false);
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
  });
}

for (const [variant, directory] of [["clocked", false], ["clocked", true], ["unclocked", true]] as const) {
  test(`${variant} config with clock directory ${directory}: required startup attestation fails closed`, async (t) => {
    const f = await fixture(t, 1, variant, directory);
    let attestations = 0;
    await assert.rejects(f.start({ prepareAttestation: async () => {
      attestations++;
      throw new Error("clock slot attestation failed");
    } }), /clock slot attestation failed/u);
    assert.equal(attestations, 1);
    assert.deepEqual(f.events, ["lease", "lease:close"]);
  });
}

test("an existing clock directory is reconciled even after the config becomes unclocked", async (t) => {
  const f = await fixture(t, 1, "unclocked", true);
  await f.start();
  assert.equal(await readFile(f.file, "utf8"), "+0\n");
  assert.ok(f.events.indexOf("proxy:+0") > f.events.indexOf("write:+0"));
});

test("a startup reset failure refuses readiness and releases its realm lease", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.start({
    writeTaskClock: async () => { throw new Error("reset unavailable"); }
  }), /reset unavailable/u);
  assert.equal(f.events.at(-1), "lease:close");
  assert.equal(f.events.some((event) => event.startsWith("proxy:")), false);
});

for (const ending of ["success", "failure"] as const) {
  test(`${ending}: cleanup failure preserves the sealed terminal through service/client and fences admission`, async (t) => {
    const f = await fixture(t);
    const warning = t.mock.method(console, "warn", () => {});
    const frames: EngineBrokerResponse[] = [];
    const observations: GrokBrokerProviderClockObservation[] = [];
    const onProviderClock = (observation: GrokBrokerProviderClockObservation) => { observations.push(observation); };
    let writes = 0;
    let beforeCleanup = "";
    const broker = await f.start({
      writeTaskClock: async (value) => {
        if (++writes === 3) {
          beforeCleanup = await f.record();
          assert.equal(JSON.parse(beforeCleanup).state, "terminal");
          throw new Error("private filesystem failure must not reach the client");
        }
        await f.dependencies.writeTaskClock(value);
      },
      runNative: ending === "failure" ? f.dependencies.runNative : async () => {
        f.events.push("launch");
        const usage = { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 };
        const text = [
          {
            type: "assistant", parent_tool_use_id: null, session_id: "s",
            message: { id: "m", role: "assistant", model: "daimon-broker-grok", usage,
              stop_reason: "end_turn", content: [{ type: "text", text: "sealed answer" }] }
          },
          { type: "result", subtype: "success", is_error: false, session_id: "s",
            stop_reason: "end_turn", result: "sealed answer", usage }
        ].map((frame) => JSON.stringify(frame)).join("\n");
        return {
          text, workerPid: 42, workerUid: 2200, startTicks: 1n,
          diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false,
            exitCode: 0, termSignal: 0, workerPid: 42, workerUid: 2200, startTicks: "1" }
        };
      }
    });
    const client = clientFor(broker, frames);
    const turn = (wake: string) => client.turn(
      "agent-0", wake, "work", "http://127.0.0.1:1/mcp", undefined, { slot: 0, processClock: "-1", onProviderClock }
    );
    const pending = turn("one");
    if (ending === "success") {
      assert.equal(await pending, "sealed answer");
      assert.deepEqual(warning.mock.calls.map((call) => call.arguments), [
        ["daimon: engine broker task clock reset failed; slot fenced until restart"]
      ]);
    } else await assert.rejects(pending, {
      message: "engine broker turn failed (engine_failed; task clock reset failed; slot fenced until restart)"
    });
    const terminal = frames[1];
    assert.ok(terminal?.kind === "completed" || terminal?.kind === "failed");
    const { cleanupDiagnostic, requestId: _wireId, ...delivered } = terminal;
    assert.equal(cleanupDiagnostic, "task clock reset failed; slot fenced until restart");
    const { requestId: _sealedId, ...sealed } = JSON.parse(beforeCleanup).response;
    assert.deepEqual(delivered, sealed, "all sealed fields, including accounting, survive cleanup failure");
    assert.equal(terminal.outcome, ending === "success" ? "completed" : "failed");
    if (ending === "success") {
      assert.equal(terminal.requests, 1);
      assert.deepEqual(terminal.usage, { input: 20, cacheRead: 5, cacheWrite: 0, output: 10, total: 35 });
    }
    assert.equal(broker.readiness().workerIsolation, false);
    for (const wake of ["one", "two"]) await assert.rejects(turn(wake), {
      message: "engine broker turn failed (unavailable; task clock reset failed; slot fenced until restart)"
    });
    assert.equal(writes, 3, "fenced requests neither publish nor reset a clock");
    assert.equal(f.events.filter((event) => event === "launch").length, 1);
    assert.equal(await f.record(), beforeCleanup, "cleanup and refused requests never rewrite the seal");
    assert.equal(await readFile(f.file, "utf8"), "-1\n");
    await broker.close();
    const restarted = await f.start();
    assert.equal(await readFile(f.file, "utf8"), "+0\n");
    assert.equal(restarted.readiness().workerIsolation, true);
    const replay = clientFor(restarted, frames).turn(
      "agent-0", "one", "work", "http://127.0.0.1:1/mcp", undefined, { slot: 0, processClock: "-1", onProviderClock }
    );
    if (ending === "success") assert.equal(await replay, "sealed answer");
    else await assert.rejects(replay, { message: "engine broker turn failed (engine_failed)" });
    assert.equal(Object.hasOwn(frames.at(-1)!, "cleanupDiagnostic"), false, "restart clears the operational warning");
    assert.equal(warning.mock.callCount(), ending === "success" ? 1 : 0);
    assert.equal(f.events.filter((event) => event === "launch").length, 1, "restart replays without re-execution");
    assert.equal(observations.length, 2, "completion/failure and sealed replay each expose the observation");
    assert.deepEqual(observations[0], observations[1]);
  });
}

test("the control client exposes missing-date release evidence without changing completion or failure", async () => {
  const clock: GrokBrokerProviderClockObservation = {
    requests: 1, linesRewritten: 0, requestsWithoutDateLine: 1, linesIgnored: 2,
    injectedDate: null, taskDate: null
  };
  for (const failed of [false, true]) for (const providerClock of [clock, undefined]) {
    const seen: GrokBrokerProviderClockObservation[] = [];
    const broker: EngineBrokerServiceEngine = {
      turn: async () => {
        const accounting = {
          outcome: failed ? "failed" as const : "completed" as const,
          usage: null, model: "grok-4.6" as const, requests: 1, limitReason: "none" as const
        };
        if (failed) throw new EngineBrokerTurnFailure("engine_failed", undefined, accounting, undefined, "task", providerClock);
        return { text: "answer", workerPid: 42, workerUid: 2200, workerStartTime: "1", ...accounting,
          ...(providerClock === undefined ? {} : { providerClock }) };
      },
      close: async () => {},
      readiness: () => ({ providerProxyPort: 43123, mcpFacadePort: 43124, registrations: 1,
        credentialStale: false, realmLease: true, workerIsolation: true })
    };
    const pending = clientFor(broker, []).turn("agent", "wake", "work", "http://127.0.0.1:1/mcp", undefined, {
      processClock: "+0",
      onProviderClock: (observation) => { seen.push(observation); throw new Error("observer failed"); }
    });
    if (failed) await assert.rejects(pending, { message: "engine broker turn failed (engine_failed)" });
    else assert.equal(await pending, "answer");
    assert.deepEqual(seen, providerClock === undefined ? [] : [clock]);
    if (providerClock !== undefined) assert.ok(seen[0]!.requestsWithoutDateLine > 0, "caller can fail the release check");
  }
});
