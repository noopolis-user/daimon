import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { GrokWorkerConfigVariant } from "../contracts/grokBrokerTaskClock.js";
import {
  startGrokEngineBroker, type GrokEngineBrokerDependencies, type GrokEngineBrokerRegistration
} from "./grokEngineBroker.js";
import { writeBrokerTaskClock } from "./grokBrokerTaskClock.js";

async function fixture(t: TestContext, count = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-start-"));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "faketime");
  await writeFile(file, "+888\n");
  const events: string[] = [];
  let variant: GrokWorkerConfigVariant = "clocked";
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
      events.push(`proxy:${(await readFile(file, "utf8")).trim()}`);
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
    profilePath: `/home/${index}/.grok/sandbox.toml`,
    eventsPath: `/home/${index}/.grok/sessions/sandbox-events.jsonl`, profileSha256: "a".repeat(64),
    usageLedgerPath: path.join(root, `usage-${index}.jsonl`),
    limits: { maxRequests: 2, maxTokens: 100, timeoutMs: 5000 },
    model: { model: "grok-4.6", reasoningEffort: "low" }
  }));
  return {
    file, events, dependencies,
    variant(value: GrokWorkerConfigVariant) { variant = value; },
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

test("production startup rejects multiple registrations when one config is clocked", async (t) => {
  const f = await fixture(t, 2);
  await assert.rejects(f.start(), /one registration/u);
  assert.deepEqual(f.events, ["lease", "attest:clocked", "lease:close"]);
});

test("production per-turn admission rejects a newly clocked multi-registration slot", async (t) => {
  const f = await fixture(t, 2);
  f.variant("unclocked");
  const broker = await f.start();
  assert.equal(f.events.some((event) => event.startsWith("write:")), false);
  f.variant("clocked");
  await assert.rejects(
    broker.turn("agent-0", "one", "work", "http://127.0.0.1:1/mcp", undefined, undefined, "-1"),
    /engine broker turn failed/u
  );
  assert.equal(f.events.includes("launch"), false);
  assert.equal(f.events.some((event) => event.startsWith("write:")), false);
  assert.equal(await readFile(f.file, "utf8"), "+888\n");
});

test("a startup reset failure refuses readiness and releases its realm lease", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.start({
    writeTaskClock: async () => { throw new Error("reset unavailable"); }
  }), /reset unavailable/u);
  assert.equal(f.events.at(-1), "lease:close");
  assert.equal(f.events.some((event) => event.startsWith("proxy:")), false);
});

test("a terminal reset failure fences production admission and readiness until restart", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  const broker = await f.start({
    writeTaskClock: async (value) => {
      if (++writes === 3) throw new Error("reset unavailable");
      await f.dependencies.writeTaskClock(value);
    }
  });
  await assert.rejects(
    broker.turn("agent-0", "one", "work", "http://127.0.0.1:1/mcp", undefined, undefined, "-1"),
    /task clock cleanup failed; restart required/u
  );
  assert.equal(broker.readiness().workerIsolation, false);
  await assert.rejects(
    broker.turn("agent-0", "two", "work", "http://127.0.0.1:1/mcp"), /unavailable/u
  );
  assert.equal(f.events.filter((event) => event === "launch").length, 1);
  await broker.close();
  const restarted = await f.start();
  assert.equal(await readFile(f.file, "utf8"), "+0\n");
  assert.equal(restarted.readiness().workerIsolation, true);
});
