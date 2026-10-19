import assert from "node:assert/strict";
import test from "node:test";
import { ORGANIZATION_RUNTIME_VERSION, ORGANIZATION_RUNTIME_V2_VERSION, parseOrganizationRuntimeConfig, relocateRuntimeConfig, type RuntimeConfigLocation } from "./index.js";

const location: RuntimeConfigLocation = {
  workspace: "/trial/workspace", home: "/trial/home", memory: "/trial/memory",
  controlToken: { from: "/protected/control-token", to: "/trial/inputs/token" }
};
const fixture = () => parseOrganizationRuntimeConfig({
  version: ORGANIZATION_RUNTIME_V2_VERSION,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "CONTROL_TOKEN" },
  agents: [{
    id: "agent", name: "Agent", instructions: "/old/workspace/instructions /old/home /old/home/memory /protected/control-token",
    workspacePath: "/old/workspace", runtimeHomePath: "/old/home", engine: { kind: "codex" },
    memory: { runtimeHomePath: "/old/home/memory", source: "/old/workspace/source", tokenBudget: 100 },
    schedule: { kind: "every", interval_ms: 1000, prompt: "Do work" },
    recording: { directory: "/recordings/agent", keepMs: 1000, snapshots: [{ id: "workspace", path: "/old/workspace" }] },
    mcp: [{ name: "tools", transport: "stdio", command: "/old/workspace/bin/tools",
      args: ["/old/home/cache", "/old/home/memory/data", "/protected/control-token", "/old/workspace-other/file", "Read /old/workspace/file"],
      env: { STATE_ROOT: "/old/workspace/state/edition", TOKEN_FILE: "/protected/control-token", TOKEN_CHILD: "/protected/control-token/child", OTHER: "/unrelated/path" }, tools: ["read"] }],
    moltnet: { cliPath: "/old/workspace/bin/moltnet", configPath: "/old/home/moltnet.json", networks: [] }
  }]
});

test("public relocation rebases every source and descendant throughout native config", () => {
  const input = fixture();
  const output = relocateRuntimeConfig(input, location);
  const agent = output.agents[0]!;
  assert.equal(agent.workspacePath, location.workspace);
  assert.equal(agent.runtimeHomePath, location.home);
  assert.deepEqual(agent.memory, { runtimeHomePath: location.memory, source: "/trial/workspace/source", tokenBudget: 100 });
  assert.equal(agent.mcp![0]!.command, "/trial/workspace/bin/tools");
  assert.deepEqual(agent.mcp![0]!.args, ["/trial/home/cache", "/trial/memory/data", "/trial/inputs/token", "/old/workspace-other/file", "Read /old/workspace/file"]);
  assert.deepEqual(agent.mcp![0]!.env, { STATE_ROOT: "/trial/workspace/state/edition", TOKEN_FILE: "/trial/inputs/token", TOKEN_CHILD: "/trial/inputs/token/child", OTHER: "/unrelated/path" });
  assert.deepEqual(agent.moltnet, { cliPath: "/trial/workspace/bin/moltnet", configPath: "/trial/home/moltnet.json", networks: [] });
  assert.deepEqual(agent.recording, { directory: "/recordings/agent", keepMs: 1000, snapshots: [{ id: "workspace", path: "/trial/workspace" }] });
  assert.equal(agent.instructions, input.agents[0]!.instructions);
  assert.deepEqual(agent.schedule, input.agents[0]!.schedule);
  assert.deepEqual(output.host, input.host);
  assert.deepEqual(parseOrganizationRuntimeConfig(output), output);
});

test("relocation never mutates or shares nested config objects", () => {
  const input = fixture(), before = structuredClone(input);
  const output = relocateRuntimeConfig(input, location);
  assert.deepEqual(input, before);
  assert.notEqual(output, input);
  assert.notEqual(output.agents[0]!.mcp![0]!.env, input.agents[0]!.mcp![0]!.env);
  (output.agents[0]!.mcp![0]!.args as string[]).push("changed");
  assert.deepEqual(input, before);
});

test("invalid input is refused before relocation can repair it", () => {
  const input = { ...fixture(), extra: true };
  assert.throws(() => relocateRuntimeConfig(input, location), /exactly|invalid fields/);
  const overlapping = fixture();
  (overlapping.agents[0]! as { workspacePath: string }).workspacePath = "/old/home";
  assert.throws(() => relocateRuntimeConfig(overlapping, location), /overlap/);
});

test("relocation validates the resulting config with the existing parser", () => {
  assert.throws(() => relocateRuntimeConfig(fixture(), { ...location, workspace: location.home }), /overlap/);
  assert.throws(() => relocateRuntimeConfig(fixture(), { ...location, memory: location.workspace }), /overlap/);
  assert.throws(() => relocateRuntimeConfig(fixture(), { ...location, workspace: "/recordings/agent" }), /overlap/);
});

test("destinations and token sources must be canonical absolute non-root POSIX paths", () => {
  for (const path of ["relative", "/", "/trial/../work", "/trial//work", "/trial/work/", "/trial\\work", "/trial/\0work"]) {
    for (const key of ["workspace", "home", "memory"] as const) {
      assert.throws(() => relocateRuntimeConfig(fixture(), { ...location, [key]: path }), /canonical absolute POSIX/);
    }
    for (const key of ["from", "to"] as const) {
      assert.throws(() => relocateRuntimeConfig(fixture(), { ...location, controlToken: { ...location.controlToken, [key]: path } }), /canonical absolute POSIX/);
    }
  }
});

test("ambiguous sources and configs without exactly one memory-backed agent are refused", () => {
  assert.throws(() => relocateRuntimeConfig(fixture(), { ...location, controlToken: { ...location.controlToken, from: "/old/home" } }), /distinct/);
  const input = fixture();
  const { memory: _memory, ...agent } = input.agents[0]!;
  assert.throws(() => relocateRuntimeConfig({ ...input, agents: [agent] }, location), /one memory-backed agent/);
  const { recording: _recording, ...unrecorded } = agent;
  const second = { ...unrecorded, id: "other", workspacePath: "/other/workspace", runtimeHomePath: "/other/home" };
  assert.throws(() => relocateRuntimeConfig({ ...input, agents: [input.agents[0]!, second] }, location), /one memory-backed agent/);
});

test("relocation preserves v1 configs without adding a schedule", () => {
  const input = fixture();
  const { schedule: _schedule, ...agent } = input.agents[0]!;
  const output = relocateRuntimeConfig({ ...input, version: ORGANIZATION_RUNTIME_VERSION, agents: [agent] }, location);
  assert.equal(output.version, ORGANIZATION_RUNTIME_VERSION);
  assert.equal(output.agents[0]!.workspacePath, location.workspace);
  assert.equal(Object.hasOwn(output.agents[0]!, "schedule"), false);
});
