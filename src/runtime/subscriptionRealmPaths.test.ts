import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSubscriptionRealmPaths } from "./subscriptionRealmPaths.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

test("trusted portable realm paths reject overlaps, symlinks, unsupported owners and ambiguous input", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "subscription-paths-")));
  const bootstrapPath = path.join(root, "bootstrap");
  const durablePath = path.join(root, "realm");
  const agent: OrganizationRuntimeAgentConfig = { id: "agent", name: "Agent", instructions: "Work", engine: { kind: "codex" }, workspacePath: path.join(root, "workspace"), runtimeHomePath: path.join(root, "home") };
  await mkdir(durablePath, { mode: 0o700 });
  await mkdir(agent.workspacePath, { mode: 0o700 });
  await mkdir(agent.runtimeHomePath, { mode: 0o700 });
  await writeFile(bootstrapPath, "test", { mode: 0o600 });
  try {
    assert.deepEqual(await prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath } }, [agent]), { codex: { bootstrapPath, durablePath } });
    for (const invalid of [null, [], { future: { bootstrapPath, durablePath } }, { grok: { bootstrapPath, durablePath } }, { codex: { bootstrapPath, durablePath, extra: true } }, { codex: { bootstrapPath: "/", durablePath } }, { codex: { bootstrapPath, durablePath: `${root}/./realm` } }]) {
      await assert.rejects(prepareSubscriptionRealmPaths(invalid as never, [agent]));
    }
    await assert.rejects(prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath } }, []), /unsupported/);
    for (const destination of [agent.workspacePath, agent.runtimeHomePath, root]) {
      await assert.rejects(prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath: destination } }, [agent]), /overlap/);
    }
    await assert.rejects(prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath } }, [agent], [durablePath]), /overlap/);
    await assert.rejects(prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath: bootstrapPath } }, [agent]), /overlap/);
    const alias = path.join(root, "alias");
    await symlink(root, alias);
    const future = path.join(alias, "realm", "not-created-yet");
    await assert.rejects(prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath } }, [{ ...agent, memory: { runtimeHomePath: future } }]), /overlap/);
    await assert.rejects(prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath } }, [agent], [future]), /overlap/);
    const linked = path.join(root, "linked");
    await symlink(durablePath, linked);
    await assert.rejects(prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath: linked } }, [agent]), /symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
