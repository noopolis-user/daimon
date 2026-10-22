import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WakeFuse } from "./wakeFuse.js";
import { grantAppliesToEpoch, parseWakeFuseGrants, WAKE_FUSE_GRANTS_VERSION } from "./wakeFuseGrants.js";

const withDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-fuse-grants-"));
  await writeFile(path.join(directory, "usage.jsonl"), "");
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const environment = (directory: string, values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DAIMON_WAKE_FUSE_DIRECTORY: directory, DAIMON_WAKE_FUSE_EPOCH: "test-epoch", DAIMON_WAKE_FUSE_MAX_WAKES: "10",
  DAIMON_WAKE_FUSE_MAX_TOKENS: "1000", DAIMON_TURN_USAGE_LEDGER_PATH: path.join(directory, "usage.jsonl"), ...values
});
const grant = async (directory: string, body: unknown): Promise<void> => await writeFile(path.join(directory, "grants.json"), typeof body === "string" ? body : JSON.stringify(body));
const usage = async (directory: string, agent: string, total: number): Promise<void> =>
  await appendFile(path.join(directory, "usage.jsonl"), `${JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), agent, total })}\n`);
const ledger = async (directory: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(path.join(directory, "admissions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
const logs = (t: test.TestContext): string[] => {
  const lines: string[] = [];
  t.mock.method(console, "error", (...values: unknown[]) => { lines.push(values.map(String).join(" ")); });
  return lines;
};
const agentLimits = { maxExecutions: 1, maxTokens: 500 };

test("a grant for the current epoch lets a parked agent resume on the same fuse, without a restart", async (t) => await withDirectory(async (directory) => {
  logs(t);
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  assert.deepEqual(await fuse.admit("pressman", "one", agentLimits), { state: "admitted" });
  await usage(directory, "pressman", 600);
  assert.deepEqual(await fuse.admit("pressman", "two", agentLimits), { state: "paused", reason: "agent_execution_ceiling" });
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", agents: { pressman: { extra_executions: 1 } } });
  // Executions lifted, tokens still over: the remaining limit still holds.
  assert.deepEqual(await fuse.admit("pressman", "two", agentLimits), { state: "paused", reason: "agent_token_ceiling" });
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", agents: { pressman: { extra_executions: 1, extra_tokens: 1000 } } });
  assert.deepEqual(await fuse.admit("pressman", "two", agentLimits), { state: "admitted" });
  const budget = await fuse.snapshot("pressman", agentLimits);
  assert.equal(budget.agent_tokens_remaining, 900);
  assert.equal(budget.agent_executions_remaining, 0);
}));

test("an organization grant clears a latched ceiling trip, and only a ceiling", async (t) => await withDirectory(async (directory) => {
  logs(t);
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  await fuse.admit("alpha", "one");
  assert.deepEqual(await fuse.admit("alpha", "two"), { state: "tripped", reason: "wake_ceiling" });
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", organization: { extra_wakes: 1 } });
  assert.deepEqual(await fuse.admit("alpha", "two"), { state: "admitted" });
  assert.deepEqual(await fuse.admit("alpha", "three"), { state: "tripped", reason: "wake_ceiling" });
  // A restart reads the latched marker; the grant still lifts it.
  await fuse.close();
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", organization: { extra_wakes: 5 } });
  const reopened = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  assert.deepEqual(await reopened.admit("alpha", "three"), { state: "admitted" });
  // An operator stop is never a ceiling: no grant reopens it.
  await writeFile(path.join(directory, "fuse.stop"), "");
  assert.deepEqual(await reopened.admit("alpha", "four"), { state: "tripped", reason: "operator_stop" });
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", organization: { extra_wakes: 100 } });
  assert.deepEqual(await reopened.admit("alpha", "five"), { state: "tripped", reason: "operator_stop" });
}));

test("an expired grant is ignored: it names another epoch", async (t) => await withDirectory(async (directory) => {
  logs(t);
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "yesterday", agents: { pressman: { extra_executions: 5 } } });
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await fuse.admit("pressman", "one", agentLimits);
  assert.deepEqual(await fuse.admit("pressman", "two", agentLimits), { state: "paused", reason: "agent_execution_ceiling" });
}));

test("a dated grant applies to the date-derived epoch of that day only", async (t) => await withDirectory(async (directory) => {
  logs(t);
  let now = new Date("2026-10-21T20:00:00.000Z");
  const env = { ...environment(directory), DAIMON_WAKE_FUSE_EPOCH: undefined, DAIMON_WAKE_FUSE_EPOCH_ZONE: "Europe/Berlin" };
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "2026-10-21", agents: { pressman: { extra_executions: 1 } } });
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: env, now: () => now });
  assert.deepEqual(await fuse.admit("pressman", "one", agentLimits), { state: "admitted" });
  assert.deepEqual(await fuse.admit("pressman", "two", agentLimits), { state: "admitted" });
  assert.deepEqual(await fuse.admit("pressman", "three", agentLimits), { state: "paused", reason: "agent_execution_ceiling" });
  // 22:30Z is 00:30 in Berlin on the 22nd: yesterday's grant expired by itself.
  now = new Date("2026-10-21T22:30:00.000Z");
  assert.deepEqual(await fuse.admit("pressman", "four", agentLimits), { state: "admitted" });
  assert.deepEqual(await fuse.admit("pressman", "five", agentLimits), { state: "paused", reason: "agent_execution_ceiling" });
  assert.equal(grantAppliesToEpoch("2026-10-21", `organization-${"a".repeat(64)}-2026-10-21`), true);
  assert.equal(grantAppliesToEpoch("2026-10-21", "pinned-2026-10-21"), false);
}));

test("a malformed grant is ignored with exactly one warning per file state", async (t) => await withDirectory(async (directory) => {
  const lines = logs(t);
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await fuse.admit("pressman", "one", agentLimits);
  for (const body of ["{not json", { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", agents: { pressman: { extra_execution: 5 } } }, { version: "v0", epoch: "test-epoch" }]) {
    await grant(directory, body);
    for (let poll = 0; poll < 3; poll++) assert.deepEqual(await fuse.admit("pressman", "two", agentLimits), { state: "paused", reason: "agent_execution_ceiling" });
  }
  assert.equal(lines.filter((line) => line.includes("wake fuse grants ignored")).length, 3);
}));

test("a grant can never lower a declared limit", async (t) => await withDirectory(async (directory) => {
  logs(t);
  assert.throws(() => parseWakeFuseGrants({ version: WAKE_FUSE_GRANTS_VERSION, epoch: "e", organization: { extra_wakes: -1 } }));
  assert.throws(() => parseWakeFuseGrants({ version: WAKE_FUSE_GRANTS_VERSION, epoch: "e", agents: { a: { extra_tokens: 1.5 } } }));
  // A negative grant poisons the whole file, so the declared limits stand untouched.
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", organization: { extra_wakes: -5 }, agents: { pressman: { extra_executions: -1 } } });
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "2" }) });
  assert.deepEqual(await fuse.admit("pressman", "one", { maxExecutions: 2 }), { state: "admitted" });
  assert.deepEqual(await fuse.admit("pressman", "two", { maxExecutions: 2 }), { state: "admitted" });
  assert.equal((await fuse.snapshot("pressman", { maxExecutions: 2 })).executions_remaining, 0);
  // A zero grant is the declared limit exactly; an undeclared per-agent limit stays unlimited.
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", organization: { extra_wakes: 0 }, agents: { pressman: { extra_executions: 0, extra_tokens: 10 } } });
  const budget = await fuse.snapshot("pressman", { maxExecutions: 2 });
  assert.equal(budget.executions_remaining, 0); assert.equal(budget.agent_executions_remaining, 0); assert.equal(budget.agent_tokens_remaining, undefined);
}));

test("a held wake is announced once per agent, reason and epoch, and once when it clears", async (t) => await withDirectory(async (directory) => {
  const lines = logs(t);
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await fuse.admit("pressman", "one", agentLimits);
  await usage(directory, "pressman", 600);
  for (let poll = 0; poll < 3; poll++) { await fuse.admit("pressman", "two", agentLimits); await fuse.snapshot("pressman", agentLimits, true); }
  // A plain availability read is not a hold and never announces one.
  await fuse.snapshot("peer", { maxExecutions: 0 + 1 }); await fuse.admit("peer", "p1", { maxExecutions: 1 }); await fuse.snapshot("peer", { maxExecutions: 1 });
  assert.deepEqual(lines.filter((line) => line.includes("wake parked")), ["daimon: wake parked agent=pressman reason=attention_executions used=1 limit=1 epoch=test-epoch"]);
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", agents: { pressman: { extra_executions: 1 } } });
  await fuse.admit("pressman", "two", agentLimits);
  await fuse.admit("pressman", "two", agentLimits);
  assert.deepEqual(lines.filter((line) => line.includes("wake parked")).at(-1), "daimon: wake parked agent=pressman reason=attention_tokens used=600 limit=500 epoch=test-epoch");
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", agents: { pressman: { extra_executions: 1, extra_tokens: 500 } } });
  await fuse.admit("pressman", "two", agentLimits);
  assert.deepEqual(lines.filter((line) => line.includes("wake unparked")), ["daimon: wake unparked agent=pressman reason=attention_tokens epoch=test-epoch"]);
  assert.deepEqual((await ledger(directory)).filter((row) => row.kind === "park" || row.kind === "unpark").map((row) => [row.kind, row.reason]), [["park", "attention_executions"], ["park", "attention_tokens"], ["unpark", "attention_tokens"]]);
}));

test("a restart does not re-announce a park the ledger already recorded", async (t) => await withDirectory(async (directory) => {
  const lines = logs(t);
  const first = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await first.admit("pressman", "one", agentLimits);
  await first.admit("pressman", "two", agentLimits);
  await first.close();
  const reopened = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await reopened.admit("pressman", "two", agentLimits);
  assert.equal(lines.filter((line) => line.includes("wake parked")).length, 1);
  assert.deepEqual(await reopened.parkedRevisitDue(), ["pressman"]);
  assert.deepEqual(await reopened.parkedRevisitDue(), []);
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", agents: { pressman: { extra_executions: 1 } } });
  assert.deepEqual(await reopened.parkedRevisitDue(), ["pressman"]);
}));

test("a grants path that cannot be opened safely is no grant, warned once", async (t) => await withDirectory(async (directory) => {
  const lines = logs(t);
  await writeFile(path.join(directory, "elsewhere.json"), JSON.stringify({ version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", agents: { pressman: { extra_executions: 5 } } }));
  await symlink(path.join(directory, "elsewhere.json"), path.join(directory, "grants.json"));
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await fuse.admit("pressman", "one", agentLimits);
  for (let poll = 0; poll < 3; poll++) assert.deepEqual(await fuse.admit("pressman", "two", agentLimits), { state: "paused", reason: "agent_execution_ceiling" });
  assert.equal(lines.filter((line) => line.includes("wake fuse grants ignored")).length, 1);
}));

test("a grant-lifted ceiling removes its trip marker, and the fuse re-trips when the grant goes", async (t) => await withDirectory(async (directory) => {
  logs(t);
  const marker = path.join(directory, "fuse.trip.json");
  const env = environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" });
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: env });
  await fuse.admit("alpha", "one");
  assert.deepEqual(await fuse.admit("alpha", "two"), { state: "tripped", reason: "wake_ceiling" });
  assert.equal(JSON.parse(await readFile(marker, "utf8")).reason, "wake_ceiling");
  await grant(directory, { version: WAKE_FUSE_GRANTS_VERSION, epoch: "test-epoch", organization: { extra_wakes: 1 } });
  assert.equal((await fuse.snapshot("alpha")).state, "available");
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
  assert.deepEqual(await fuse.admit("alpha", "two"), { state: "admitted" });
  await rm(path.join(directory, "grants.json"));
  assert.deepEqual(await fuse.admit("alpha", "three"), { state: "tripped", reason: "wake_ceiling" });
  const rewritten = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
  assert.equal(rewritten.epoch, "test-epoch"); assert.equal(rewritten.reason, "wake_ceiling");
  // And a restart honours the re-written marker.
  await fuse.close();
  const reopened = await WakeFuse.open({ organizationKey: "org", environment: env });
  assert.equal(reopened.tripped(), "wake_ceiling");
}));

test("a day change makes a parked agent due for a revisit, with no grant file at all", async (t) => await withDirectory(async (directory) => {
  logs(t);
  let now = new Date("2026-10-21T21:00:00.000Z");
  const env = { ...environment(directory), DAIMON_WAKE_FUSE_EPOCH: undefined, DAIMON_WAKE_FUSE_EPOCH_ZONE: "Europe/Berlin" };
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: env, now: () => now });
  await fuse.admit("pressman", "one", agentLimits);
  assert.equal((await fuse.admit("pressman", "two", agentLimits)).state, "paused");
  assert.deepEqual(await fuse.parkedRevisitDue(), ["pressman"]);
  assert.deepEqual(await fuse.parkedRevisitDue(), []);
  now = new Date("2026-10-21T21:59:59.000Z");
  assert.deepEqual(await fuse.parkedRevisitDue(), [], "still the 21st in Berlin");
  now = new Date("2026-10-21T22:00:01.000Z");
  assert.deepEqual(await fuse.parkedRevisitDue(), ["pressman"], "Berlin midnight renews the budget");
}));
