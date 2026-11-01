import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ENGINE_CREDENTIAL_MATERIAL, GROK_SUBSCRIPTION_REALM } from "./contractManifest.js";
import { engineAuthFile, engineHomeName, prepareEngineExecutable, prepareEngineReadiness } from "./engineReadiness.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const agent = (root: string, kind: "codex" | "grok" | "agy"): OrganizationRuntimeAgentConfig => ({
  id: "safe-agent", name: "Safe", instructions: "Work.", workspacePath: path.join(root, "workspace"), runtimeHomePath: path.join(root, "home"), engine: { kind }
});

test("varying stderr is not a capability change while varying stdout is", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-stderr-"));
  const previousPath = process.env.PATH;
  try {
    const executable = path.join(root, "codex");
    // Emulation-dependent allocator noise on stderr differs run to run; the version on stdout does not.
    await writeFile(executable, "#!/usr/bin/env node\nif (process.argv.includes('--version')) { process.stderr.write(`<jemalloc>: warning ${Math.random()}`); process.stdout.write('1.0.13'); }", { mode: 0o700 });
    await chmod(executable, 0o700);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    const readiness = await prepareEngineExecutable("safe-agent", "codex");
    await readiness.verify();
    await readiness.verify();
    // A real capability change is still caught.
    await writeFile(executable, "#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('9.9.9');", { mode: 0o700 });
    await chmod(executable, 0o700);
    await assert.rejects(readiness.verify(), /is unavailable/u);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("pins an executable and refuses a replaced one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-ready-"));
  const previousPath = process.env.PATH;
  try {
    const executable = path.join(root, "codex");
    await writeFile(executable, "#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('test');", { mode: 0o700 });
    await chmod(executable, 0o700);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    const readiness = await prepareEngineExecutable("safe-agent", "codex");
    await readiness.verify();
    await rename(executable, `${executable}.replaced`);
    await assert.rejects(readiness.verify(), /safe-agent codex is unavailable/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex and Grok never verify a login in the agent home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-home-login-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    for (const kind of ["codex", "grok"] as const) {
      const config = agent(root, kind);
      await writeFile(path.join(root, kind), "#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('test');", { mode: 0o700 });
      await chmod(path.join(root, kind), 0o700);
      await assert.rejects(prepareEngineReadiness(config, config.runtimeHomePath), /held by the auth gateway or engine broker/u);
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for missing or unsafe credentials without reflecting their path or contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-auth-"));
  const previousPath = process.env.PATH;
  try {
    const config = agent(root, "agy");
    await mkdir(config.workspacePath, { recursive: true, mode: 0o700 });
    await mkdir(path.join(config.runtimeHomePath, ".antigravity-cli"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, "agy"), "#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('test'); else process.exitCode = 1;", { mode: 0o700 });
    await chmod(path.join(root, "agy"), 0o700);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    await assert.rejects(prepareEngineReadiness(config, config.runtimeHomePath, "unix:path=/private/realm/bus"), (error: Error) => {
      assert.match(error.message, /safe-agent agy is unavailable/);
      assert.match(error.message, /subscription enrollment is required/);
      assert.doesNotMatch(error.message, /antigravity-oauth-token|daimon-engine-auth/);
      return true;
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
test("verifies AGY through its noninteractive native secure-storage probe without a portable token file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-engine-agy-native-"));
  const previousPath = process.env.PATH;
  try {
    const config = agent(root, "agy");
    const probeLog = path.join(root, "probe-log");
    await Promise.all([
      mkdir(config.workspacePath, { recursive: true, mode: 0o700 }),
      mkdir(config.runtimeHomePath, { recursive: true, mode: 0o700 })
    ]);
    await writeFile(path.join(root, "agy"), [
      "#!/usr/bin/env node",
      `import { appendFileSync } from "node:fs";`,
      `if (process.argv.includes("--version")) process.stdout.write("1.1.19");`,
      `else if (process.argv.includes("models")) appendFileSync(${JSON.stringify(probeLog)}, process.env.HOME + "|" + process.env.DBUS_SESSION_BUS_ADDRESS + "\\n");`,
      `else process.exitCode = 2;`
    ].join("\n"), { mode: 0o700 });
    await chmod(path.join(root, "agy"), 0o700);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;

    const readiness = await prepareEngineReadiness(config, config.runtimeHomePath, "unix:path=/private/realm/bus");
    await readiness.verify();

    assert.equal(readiness.engineHomePath, config.runtimeHomePath);
    assert.equal(await readFile(probeLog, "utf8"), `${config.runtimeHomePath}|unix:path=/private/realm/bus\n${config.runtimeHomePath}|unix:path=/private/realm/bus\n`);
    assert.equal((ENGINE_CREDENTIAL_MATERIAL as Partial<Record<string, unknown>>).agy, undefined);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness derives every engine home, credential file, and required mode from the manifest", () => {
  const root = "/runtime-home";
  for (const kind of ["codex"] as const) {
    const rule = ENGINE_CREDENTIAL_MATERIAL[kind];
    const engineHome = path.join(root, engineHomeName(kind));
    assert.equal(engineHome, path.join(root, path.dirname(rule.destinationRelativePath)));
    assert.equal(engineAuthFile(kind, engineHome), path.join(root, rule.destinationRelativePath));
    assert.equal(rule.directoryMode, 0o700);
    assert.equal(rule.fileMode, 0o600);
  }
  assert.equal(engineHomeName("grok"), ".grok");
  assert.equal(engineAuthFile("grok", path.join(root, ".grok")), path.join(root, GROK_SUBSCRIPTION_REALM.agentCredentialRelativePath));
});
