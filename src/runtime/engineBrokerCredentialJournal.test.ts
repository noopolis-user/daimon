import assert from "node:assert/strict";
import test from "node:test";
import { parseBrokerCredentialJournal, recoverBrokerCredentialJournal } from "./engineBrokerCredentialJournal.js";
const a = "a".repeat(64); const b = "b".repeat(64);
test("credential crash recovery distinguishes pre and post replacement", () => {
  const refreshing = parseBrokerCredentialJournal({ version: "noopolis.daimon.broker-credential-journal.v1", state: "refreshing", generation: 3, sourceDigest: a });
  assert.equal(recoverBrokerCredentialJournal(refreshing, a), "ready"); assert.equal(recoverBrokerCredentialJournal(refreshing, b), "stale");
  const promoted = parseBrokerCredentialJournal({ ...refreshing, state: "promoted", promotedDigest: b });
  assert.equal(recoverBrokerCredentialJournal(promoted, b), "ready"); assert.equal(recoverBrokerCredentialJournal(promoted, a), "stale");
});

test("credential journals accept legacy rows and validated ancestry only", () => {
  const row = { version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted", generation: 2, sourceDigest: a, promotedDigest: b };
  assert.deepEqual(parseBrokerCredentialJournal(row), row);
  assert.deepEqual(parseBrokerCredentialJournal({ ...row, ancestorDigests: [a] }).ancestorDigests, [a]);
  for (const ancestorDigests of [null, "invalid", ["invalid"], [a, a], Array(901).fill(a)]) {
    assert.throws(() => parseBrokerCredentialJournal({ ...row, ancestorDigests }), /invalid credential journal/u);
  }
});
