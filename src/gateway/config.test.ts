import assert from "node:assert/strict";
import test from "node:test";

import { GATEWAY_CONFIG_VERSION, parseGatewayConfig } from "./config.js";

const base = { version: GATEWAY_CONFIG_VERSION, key_table_path: "/etc/daimon-gateway/keys.json", codex: {} };

test("parses a minimal config with loopback defaults", () => {
  assert.deepEqual(parseGatewayConfig(base), { host: "127.0.0.1", port: 0, keyTablePath: "/etc/daimon-gateway/keys.json", codex: {} });
  assert.equal(parseGatewayConfig({ ...base, codex: { upstream_base_url: "http://127.0.0.1:9/backend-api/codex/" } }).codex.upstreamBaseUrl, "http://127.0.0.1:9/backend-api/codex");
});

test("refuses remote upstream overrides, unknown members and relative paths", () => {
  for (const value of [
    { ...base, codex: { upstream_base_url: "https://evil.example/codex" } },
    { ...base, codex: { token_url: "http://10.0.0.1/oauth/token" } },
    { ...base, codex: { headers: {} } },
    { ...base, extra: true },
    { ...base, key_table_path: "keys.json" },
    { ...base, host: "localhost" },
    { ...base, version: "v0" }
  ]) assert.throws(() => parseGatewayConfig(value), TypeError);
});
