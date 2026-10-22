import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GrokBrokerRunBudget, GrokBrokerRunLimit } from "./grokBrokerRunBudget.js";

test("concurrent reservations persist before forwarding and survive broker restart", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "budget.json");
  const budget = await GrokBrokerRunBudget.open(5, file);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => budget.reserve()));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 5);
  assert.ok(results.filter(r => r.status === "rejected").every(r => r.reason instanceof GrokBrokerRunLimit));
  assert.equal(JSON.parse(await readFile(file, "utf8")).used, 5);
  await assert.rejects((await GrokBrokerRunBudget.open(5, file)).reserve(), GrokBrokerRunLimit);
  await assert.rejects(GrokBrokerRunBudget.open(6, file), /checkpoint/);
  await writeFile(file, '{"schema":"daimon.run-requests.v1","maximum":5,"used":-1}');
  await assert.rejects(GrokBrokerRunBudget.open(5, file), /checkpoint/);
  for (const invalid of [0, -1, 1.5, Infinity]) await assert.rejects(GrokBrokerRunBudget.open(invalid, file), /cap/);
});

test("a publication failure fences every subsequent reservation", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const budget = await GrokBrokerRunBudget.open(5, path.join(root, "budget.json"));
  await rm(root, { recursive: true });
  await assert.rejects(budget.reserve());
  await assert.rejects(budget.reserve(), /unavailable/);
});

test("close fences new admissions and drains durable reservations before releasing ownership", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-budget-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "budget.json");
  const budget = await GrokBrokerRunBudget.open(5, file);
  const pending = Array.from({ length: 5 }, () => budget.reserve());
  const closing = budget.close();
  await assert.rejects(budget.reserve(), /closed/);
  await closing;
  assert.equal(JSON.parse(await readFile(file, "utf8")).used, 5);
  await Promise.all(pending);
  await assert.rejects((await GrokBrokerRunBudget.open(5, file)).reserve(), GrokBrokerRunLimit);
});
