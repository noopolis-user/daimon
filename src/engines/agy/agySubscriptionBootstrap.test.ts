import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgyBootstrapInvocation, runAgySubscriptionBootstrap } from "./agySubscriptionBootstrap.js";
import type { OrganizationRuntimeConfig } from "../../runtime/organizationRuntime.js";

test("constructs an argument-free interactive AGY child with only Daimon's exact bus", () => {
  const invocation = createAgyBootstrapInvocation({
    busAddress: "unix:path=/private/realm/bus",
    executablePath: "/pinned/bin/agy",
    runtimeHomePath: "/runtime/home",
    workspacePath: "/workspace"
  });
  assert.equal(invocation.command, "/pinned/bin/agy");
  assert.deepEqual(invocation.args, []);
  assert.equal(invocation.env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/private/realm/bus");
  assert.equal(invocation.env.SSH_CONNECTION, undefined);
  assert.equal(invocation.env.AGY_TOKEN, undefined);
});

test("runs interactive enrollment and the models proof only as AGY children", async (t) => {
  const previousEnvironment = process.env;
  process.env = { ...previousEnvironment, NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2001-01-01T00:00:00Z", anchorEpochMs: Date.now() }), LD_PRELOAD: "/missing/libfaketime.so.1", FAKETIME: "stale" };
  t.after(() => { process.env = previousEnvironment; });
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-agy-bootstrap-"));
  const workspacePath = path.join(root, "workspace");
  const runtimeHomePath = path.join(root, "runtime");
  const observation = path.join(root, "observation.jsonl");
  const executable = path.join(root, "agy");
  const previousPath = process.env.PATH;
  try {
    await Promise.all([
      mkdir(workspacePath, { mode: 0o700 }),
      mkdir(runtimeHomePath, { mode: 0o700 })
    ]);
    await writeFile(executable, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(observation)}, JSON.stringify({ args: process.argv.slice(2), bus: process.env.DBUS_SESSION_BUS_ADDRESS, home: process.env.HOME, ssh: Boolean(process.env.SSH_CONNECTION) }) + '\\n');`,
      "if (process.argv.includes('--version')) process.stdout.write('agy 1.1.19');"
    ].join("\n"), { mode: 0o700 });
    await chmod(executable, 0o700);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    const config: OrganizationRuntimeConfig = {
      version: "noopolis.daimon.organization-runtime.v1",
      host: { bindHost: "127.0.0.1", port: 19700, controlTokenEnv: "CONTROL_TOKEN" },
      agents: [{
        id: "agent:agy", name: "AGY", instructions: "Work.", workspacePath, runtimeHomePath,
        engine: { kind: "agy" }
      }]
    };
    let closed = 0;
    await runAgySubscriptionBootstrap(config, async () => ({
      busAddress: "unix:path=/private/realm/bus",
      async withCredential(agent, operation) {
        assert.equal(agent.id, "agent:agy");
        await appendFile(observation, `${JSON.stringify({ args: ["lease-enter"] })}\n`);
        const result = await operation();
        await appendFile(observation, `${JSON.stringify({ args: ["lease-exit"] })}\n`);
        return result;
      },
      close: async () => { closed += 1; }
    }));
    const allRecords = (await readFile(observation, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      args: string[]; bus?: string; home?: string; ssh: boolean;
    });
    assert.deepEqual(allRecords.map((record) => record.args), [["--version"], ["lease-enter"], [], ["--version"], ["models"], ["lease-exit"]]);
    const records = allRecords.filter((record) => !record.args[0]?.startsWith("lease-"));
    assert.deepEqual(records.map((record) => record.args), [["--version"], [], ["--version"], ["models"]]);
    assert.equal(records.find((record) => record.args.length === 0)?.ssh, false);
    assert.equal(records.find((record) => record.args.includes("models"))?.ssh, false);
    assert.ok(records.every((record) => record.args.includes("--version") || record.bus === "unix:path=/private/realm/bus"));
    const canonicalHome = await realpath(runtimeHomePath);
    assert.ok(records.filter((record) => !record.args.includes("--version")).every((record) => record.home === canonicalHome));
    assert.equal(closed, 1);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
