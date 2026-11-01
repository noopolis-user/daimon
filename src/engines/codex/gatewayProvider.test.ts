import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shellEnvironmentPolicyEntries } from "../../contracts/shellEnvironmentPolicy.js";
import { renderCodexArgs } from "./piArgs.js";
import { codexPiHooks } from "./piHooks.js";
import { codexRuntimeHooks } from "./runtimeHooks.js";
import { assertNoCodexHomeCredential, codexGatewayFromEnvironment, codexGatewayProviderArgs, DAIMON_GATEWAY_KEY_ENV, DAIMON_GATEWAY_URL_ENV, verifyCodexGateway } from "./gatewayProvider.js";

const KEY = "synthetic-gateway-agent-key-0001";

function withGatewayEnvironment(t: import("node:test").TestContext, url = "http://127.0.0.1:43200"): void {
  const previous = { url: process.env[DAIMON_GATEWAY_URL_ENV], key: process.env[DAIMON_GATEWAY_KEY_ENV] };
  process.env[DAIMON_GATEWAY_URL_ENV] = url;
  process.env[DAIMON_GATEWAY_KEY_ENV] = KEY;
  t.after(() => {
    for (const [name, value] of [[DAIMON_GATEWAY_URL_ENV, previous.url], [DAIMON_GATEWAY_KEY_ENV, previous.key]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

test("the gateway key env name keeps the _KEY suffix Codex's shell policy excludes", () => {
  assert.match(DAIMON_GATEWAY_KEY_ENV, /_KEY$/u);
  // Codex's default excludes (`*KEY*`, `*SECRET*`, `*TOKEN*`) stay on for every Daimon shell policy.
  assert.ok(shellEnvironmentPolicyEntries({}).includes("ignore_default_excludes=false"));
  assert.ok(shellEnvironmentPolicyEntries({}).includes('inherit="all"'));
});

test("gateway mode needs both variables and a plain URL", () => {
  assert.equal(codexGatewayFromEnvironment({}), undefined);
  assert.deepEqual(codexGatewayFromEnvironment({ [DAIMON_GATEWAY_URL_ENV]: "http://gw:8080/", [DAIMON_GATEWAY_KEY_ENV]: KEY }), { url: "http://gw:8080", key: KEY });
  assert.throws(() => codexGatewayFromEnvironment({ [DAIMON_GATEWAY_URL_ENV]: "http://gw:8080" }), /set together/u);
  assert.throws(() => codexGatewayFromEnvironment({ [DAIMON_GATEWAY_KEY_ENV]: KEY }), /set together/u);
  assert.throws(() => codexGatewayFromEnvironment({ [DAIMON_GATEWAY_URL_ENV]: "http://user:pw@gw", [DAIMON_GATEWAY_KEY_ENV]: KEY }), /plain/u);
  assert.throws(() => codexGatewayFromEnvironment({ [DAIMON_GATEWAY_URL_ENV]: "file:///x", [DAIMON_GATEWAY_KEY_ENV]: KEY }), /plain/u);
  assert.throws(() => codexGatewayFromEnvironment({ [DAIMON_GATEWAY_URL_ENV]: "http://gw", [DAIMON_GATEWAY_KEY_ENV]: "short" }), /not a gateway key/u);
});

test("renders the custom provider block only in gateway mode, never the key itself", (t) => {
  const plain = renderCodexArgs({}, "/workspace", "http://127.0.0.1:1/mcp", "workspace-write");
  assert.ok(!plain.some((arg) => arg.includes("model_provider")));
  withGatewayEnvironment(t);
  const args = renderCodexArgs({}, "/workspace", "http://127.0.0.1:1/mcp", "workspace-write");
  const expected = codexGatewayProviderArgs({ url: "http://127.0.0.1:43200", key: KEY });
  assert.deepEqual(expected, ["-c", 'model_provider="daimon_gateway"', "-c", 'model_providers.daimon_gateway={name="daimon-gateway",base_url="http://127.0.0.1:43200/v1/codex",env_key="DAIMON_GATEWAY_KEY",wire_api="responses",supports_websockets=false}']);
  const start = args.indexOf(expected[1]!);
  assert.ok(start > 0);
  assert.deepEqual(args.slice(start - 1, start + 3), expected);
  assert.ok(!args.some((arg) => arg.includes(KEY)), "the key never appears in argv");
  assert.equal(codexPiHooks.environmentVariables({ engineHomePath: "/home/.codex" })[DAIMON_GATEWAY_KEY_ENV], KEY);
});

test("the gateway key joins the redaction set", async (t) => {
  withGatewayEnvironment(t);
  const options = codexRuntimeHooks.runtimeSessionOptions({ agent: { id: "alpha", engine: { kind: "codex" } } as never, engineHomePath: "/nonexistent/.codex", wakeEnvironmentContext: {}, sandbox: {} } as never) as { credentialSecretValues: () => Promise<readonly string[]> };
  assert.deepEqual(await options.credentialSecretValues(), [KEY]);
});

test("readiness calls the authenticated health route and refuses a credential in CODEX_HOME", async (t) => {
  const seen: (string | undefined)[] = [];
  let healthy = true;
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(healthy ? 200 : 403, { "content-type": "application/json" });
    response.end(JSON.stringify(healthy ? { status: "ok", engines: ["codex"] } : { error: "auth_stale" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const gateway = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, key: KEY };
  await verifyCodexGateway("alpha", gateway);
  assert.deepEqual(seen, [`Bearer ${KEY}`]);
  healthy = false;
  await assert.rejects(verifyCodexGateway("alpha", gateway), /auth gateway is not ready/u);
  await assert.rejects(verifyCodexGateway("alpha", { url: "http://127.0.0.1:1", key: KEY }), /not ready/u);

  const home = await mkdtemp(path.join(os.tmpdir(), "daimon-codex-gateway-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".codex"), { mode: 0o700 });
  await assertNoCodexHomeCredential("alpha", path.join(home, ".codex"));
  await writeFile(path.join(home, ".codex", "auth.json"), "{}", { mode: 0o600 });
  await assert.rejects(assertNoCodexHomeCredential("alpha", path.join(home, ".codex")), /no credential in gateway mode/u);
});
