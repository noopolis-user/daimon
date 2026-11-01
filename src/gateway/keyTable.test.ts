import assert from "node:assert/strict";
import test from "node:test";

import { gatewayKeyDigest, GATEWAY_KEY_TABLE_VERSION, parseGatewayKeyTable } from "./keyTable.js";

const KEY = "synthetic-agent-key-alpha-0001";

test("looks up an agent by the digest of its key and nothing else", () => {
  const table = parseGatewayKeyTable({ version: GATEWAY_KEY_TABLE_VERSION, keys: { [gatewayKeyDigest(KEY)]: { agent_id: "alpha", engines: ["codex"] }, [gatewayKeyDigest("synthetic-agent-key-beta-0002")]: { agent_id: "beta", engines: ["codex"] } } });
  assert.equal(table.size, 2);
  assert.deepEqual(table.lookup(KEY), { agentId: "alpha", engines: ["codex"], digest: gatewayKeyDigest(KEY) });
  assert.equal(table.lookup("synthetic-agent-key-beta-0002")?.agentId, "beta");
  for (const wrong of [undefined, "", "short", `${KEY}x`, gatewayKeyDigest(KEY), "x".repeat(600)]) assert.equal(table.lookup(wrong), undefined);
});

test("refuses malformed tables", () => {
  const digest = gatewayKeyDigest(KEY);
  for (const value of [
    {}, { version: "v0", keys: {} }, { version: GATEWAY_KEY_TABLE_VERSION, keys: {}, extra: 1 },
    { version: GATEWAY_KEY_TABLE_VERSION, keys: { [digest.toUpperCase()]: { agent_id: "a", engines: ["codex"] } } },
    { version: GATEWAY_KEY_TABLE_VERSION, keys: { [digest]: { agent_id: "a", engines: [] } } },
    { version: GATEWAY_KEY_TABLE_VERSION, keys: { [digest]: { agent_id: "a", engines: ["agy"] } } },
    { version: GATEWAY_KEY_TABLE_VERSION, keys: { [digest]: { agent_id: "a", engines: ["codex"], token: "x" } } },
    { version: GATEWAY_KEY_TABLE_VERSION, keys: { [digest]: { agent_id: "../a", engines: ["codex"] } } }
  ]) assert.throws(() => parseGatewayKeyTable(value), TypeError);
});
