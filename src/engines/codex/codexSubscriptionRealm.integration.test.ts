import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_SUBSCRIPTION_REALM } from "../../contracts/runtimeContractManifest.js";
import { createOrganizationRuntimeHost } from "../../runtime/organizationRuntimeHost.js";
import type { OrganizationRuntimeAgentConfig } from "../../runtime/organizationRuntime.js";

const credential = (generation: number) => JSON.stringify({ tokens: { access_token: `access-${generation}`, refresh_token: `refresh-${generation}` }, generation });

test("production Codex wakes stage before readiness, serialize rotation, and remove credentials afterward", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codex-realm-dispatch-")));
  const prior = { ...process.env };
  const durablePath = path.join(root, "realm");
  const bootstrapPath = path.join(root, "bootstrap");
  const flock = path.join(root, "flock");
  const executable = path.join(root, "codex");
  const eventsPath = path.join(root, "events.jsonl");
  const agents: OrganizationRuntimeAgentConfig[] = ["first", "second"].map((id) => ({
    id, name: id, instructions: "Reply.", engine: { kind: "codex" },
    runtimeHomePath: path.join(root, "homes", id), workspacePath: path.join(root, "workspaces", id)
  }));
  await mkdir(durablePath, { mode: 0o700 });
  await writeFile(bootstrapPath, credential(0), { mode: 0o600 });
  await writeFile(flock, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-realm-test'); process.exit(0); }
const auth = process.env.CODEX_HOME + '/auth.json';
const before = JSON.parse(fs.readFileSync(auth, 'utf8'));
fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({phase:'start', generation:before.generation})+'\\n');
setTimeout(() => {
  const generation = before.generation + 1;
  fs.writeFileSync(auth, JSON.stringify({tokens:{access_token:'access-'+generation,refresh_token:'refresh-'+generation},generation}), {mode:0o600});
  fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({phase:'end', generation})+'\\n');
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'generation-'+generation}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
}, 100);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  for (const agent of agents) {
    await mkdir(path.join(agent.runtimeHomePath, ".codex"), { recursive: true, mode: 0o700 });
    await mkdir(agent.workspacePath, { recursive: true, mode: 0o700 });
  }
  process.env.PATH = `${root}${path.delimiter}${prior.PATH ?? ""}`;
  process.env.NOOPOLIS_RUN_ID = "codex-realm-dispatch-test";
  process.env.DAIMON_TURN_USAGE_LEDGER_PATH = path.join(root, "usage.jsonl");
  process.env.TEST_CONTROL = "realm-test-control";
  const originalContract = { ...CODEX_SUBSCRIPTION_REALM };
  // Replace only the deployer-owned mount locations; exercise the real host,
  // registry, readiness hook, descriptor and dispatcher, with no owner injected.
  Object.assign(CODEX_SUBSCRIPTION_REALM, { durableMountPath: durablePath, bootstrapMountPath: bootstrapPath });
  const host = createOrganizationRuntimeHost({ version: "noopolis.daimon.organization-runtime.v1", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "TEST_CONTROL" }, agents });
  try {
    await host.start();
    const results = await Promise.all(agents.map((agent, index) => host.wake({ token: "realm-test-control", agentId: agent.id, event: { version: "noopolis.daimon.wake.v1", id: `wake-${index}`, kind: "manual", text: "probe", occurredAt: new Date().toISOString() } })));
    for (const result of results) assert.equal(result.status, "completed");
    assert.deepEqual(results.map((result) => result.status === "completed" ? result.text : result.status), ["generation-1", "generation-2"]);
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events, [{ phase: "start", generation: 0 }, { phase: "end", generation: 1 }, { phase: "start", generation: 1 }, { phase: "end", generation: 2 }]);
    for (const agent of agents) await assert.rejects(readFile(path.join(agent.runtimeHomePath, ".codex", "auth.json")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(path.join(durablePath, "auth.json"), "utf8")).generation, 2);
  } finally {
    await host.stop();
    Object.assign(CODEX_SUBSCRIPTION_REALM, originalContract);
    process.env = prior;
    await rm(root, { recursive: true, force: true });
  }
});
