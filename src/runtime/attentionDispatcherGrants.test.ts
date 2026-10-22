import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AttentionRegistry } from "./attention.js";
import type { OrganizationRuntimeHost, OrganizationRuntimeWakeRequest, OrganizationRuntimeWakeResult } from "./organizationRuntime.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { WAKE_FUSE_GRANTS_VERSION } from "./wakeFuseGrants.js";

const token = "grant-test";
const storeOptions = { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true };
const config = (maxExecutions: number) => ({ version: "noopolis.daimon.organization-runtime.v1", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "GRANT_TEST" }, agents: [{ id: "pressman", name: "pressman", instructions: "Act", workspacePath: "/workspace/pressman", runtimeHomePath: "/home/pressman", engine: { kind: "codex" }, attention: { maxBatchMessages: 1, maxExecutions } }] });
const request = (id: string) => ({ token, agent_id: "pressman", delivery_id: id, event: { version: "noopolis.daimon.wake.v2", kind: "message", text: `Handle ${id}`, occurred_at: "2026-10-21T00:00:00.000Z" } });
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>): Promise<void> { for (let n = 0; n < 400; n++) { if (await check()) return; await pause(); } throw new Error("expected side effect did not appear"); }

class Core implements OrganizationRuntimeHost {
  wakes: OrganizationRuntimeWakeRequest[] = [];
  releases: Array<(value: OrganizationRuntimeWakeResult) => void> = [];
  async start() {}
  wake(request: OrganizationRuntimeWakeRequest): Promise<OrganizationRuntimeWakeResult> { this.wakes.push(request); return new Promise((resolve) => this.releases.push(resolve)); }
  complete(index: number) { const wake = this.wakes[index]!; this.releases[index]!({ version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: wake.agentId, wakeId: wake.event.id, text: "done", durationMs: 1 }); }
  async health() { return { version: "noopolis.daimon.organization-runtime-health.v1" as const, state: "running" as const, agents: [] }; }
  async activity() { return { version: "noopolis.daimon.organization-runtime-activity.v1" as const, items: [] }; }
  async stop() { this.releases.forEach((release, index) => release({ version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: this.wakes[index]!.agentId, wakeId: this.wakes[index]!.event.id, code: "active_wake_aborted" })); return { version: "noopolis.daimon.organization-runtime-stop.v1" as const, state: "stopped" as const }; }
}

async function fixture(maxExecutions: number, maxWakes: number, fuseNowForTest?: () => Date) {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grant-")); await chmod(root, 0o700);
  const usage = await mkdtemp(path.join(os.tmpdir(), "daimon-grant-usage-")); await writeFile(path.join(usage, "usage.jsonl"), "");
  const registry: AttentionRegistry = new Map();
  const core = new Core();
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config(maxExecutions), core, {
    acceptanceStorePath: root, controlToken: token, storeOptions, attentionRegistryForTest: registry, fusePollIntervalMsForTest: 10, ...(fuseNowForTest === undefined ? {} : { fuseNowForTest }),
    fuseEnvironment: { DAIMON_WAKE_FUSE_DIRECTORY: usage, ...(fuseNowForTest === undefined ? { DAIMON_WAKE_FUSE_EPOCH: "edition" } : { DAIMON_WAKE_FUSE_EPOCH_ZONE: "Europe/Berlin" }), DAIMON_WAKE_FUSE_MAX_WAKES: String(maxWakes), DAIMON_WAKE_FUSE_MAX_TOKENS: "10000", DAIMON_TURN_USAGE_LEDGER_PATH: path.join(usage, "usage.jsonl") }
  });
  await control.start();
  const spend = async () => {
    await control.accept(request("one")); await until(() => core.wakes.length === 1);
    await registry.get("pressman")!.disposition("one", "complete"); core.complete(0);
    await control.accept(request("two"));
    await until(async () => (await control.availability(token))!.agents[0]!.budget.state === "paused");
  };
  return { usage, core, control, spend, cleanup: async () => { await control.stop(); await rm(root, { recursive: true, force: true }); await rm(usage, { recursive: true, force: true }); } };
}

const captureLogs = (t: test.TestContext): string[] => {
  const lines: string[] = [];
  t.mock.method(console, "error", (...values: unknown[]) => { lines.push(values.map(String).join(" ")); });
  return lines;
};

test("an operator grant resumes a budget-parked agent's queued wake with no restart and no new mail", async (t) => {
  const lines = captureLogs(t);
  const f = await fixture(1, 100);
  try {
    await f.spend();
    await pause(60);
    assert.equal(f.core.wakes.length, 1, "the queued wake is held while the agent budget is spent");
    assert.deepEqual(lines.filter((line) => line.includes("wake parked")), ["daimon: wake parked agent=pressman reason=attention_executions used=1 limit=1 epoch=edition"]);
    await writeFile(path.join(f.usage, "grants.json"), JSON.stringify({ version: WAKE_FUSE_GRANTS_VERSION, epoch: "edition", agents: { pressman: { extra_executions: 1 } } }));
    await until(() => f.core.wakes.length === 2);
    assert.match(f.core.wakes[1]!.event.text, /Handle two/u);
    assert.deepEqual(lines.filter((line) => line.includes("wake unparked")), ["daimon: wake unparked agent=pressman reason=attention_executions epoch=edition"]);
    assert.equal(lines.filter((line) => line.includes("wake parked")).length, 1, "polling a parked agent never repeats the alert");
  } finally { await f.cleanup(); }
});

test("an organization grant reopens a tripped organization wake ceiling with no restart", async (t) => {
  const lines = captureLogs(t);
  const f = await fixture(100, 1);
  try {
    await f.spend();
    await pause(60);
    assert.equal(f.core.wakes.length, 1);
    assert.equal(lines.filter((line) => line.includes("wake parked agent=pressman reason=org_wakes used=1 limit=1")).length, 1);
    await writeFile(path.join(f.usage, "grants.json"), JSON.stringify({ version: WAKE_FUSE_GRANTS_VERSION, epoch: "edition", organization: { extra_wakes: 1 } }));
    await until(() => f.core.wakes.length === 2);
  } finally { await f.cleanup(); }
});

test("a grant for another epoch leaves the parked wake held", async (t) => {
  captureLogs(t);
  const f = await fixture(1, 100);
  try {
    await f.spend();
    await writeFile(path.join(f.usage, "grants.json"), JSON.stringify({ version: WAKE_FUSE_GRANTS_VERSION, epoch: "last-edition", agents: { pressman: { extra_executions: 5 } } }));
    await pause(100);
    assert.equal(f.core.wakes.length, 1);
  } finally { await f.cleanup(); }
});

test("Berlin midnight resumes a budget-parked agent's queued wake with no restart and no new mail", async (t) => {
  const lines = captureLogs(t);
  let now = new Date("2026-10-21T21:59:00.000Z");
  const f = await fixture(1, 100, () => now);
  try {
    await f.spend();
    await pause(60);
    assert.equal(f.core.wakes.length, 1, "held while the day's agent budget is spent");
    now = new Date("2026-10-21T22:00:30.000Z");
    await until(() => f.core.wakes.length === 2);
    assert.match(f.core.wakes[1]!.event.text, /Handle two/u);
    assert.equal(lines.filter((line) => line.includes("wake unparked agent=pressman")).length, 1);
  } finally { await f.cleanup(); }
});
