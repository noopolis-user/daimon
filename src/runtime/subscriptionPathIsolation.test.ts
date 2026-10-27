import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSubscriptionMountInfo } from "./subscriptionPathIsolation.js";
import { prepareSubscriptionRealmPaths } from "./subscriptionRealmPaths.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

test("mount roots preserve device identity and escaped directory names", () => {
  const mounts = parseSubscriptionMountInfo("12 1 8:1 / / rw - ext4 /dev/root rw\n13 12 8:1 /private\\040data/auth /run/bootstrap rw - ext4 /dev/root rw\n");
  assert.deepEqual(mounts.get("13"), { device: "8:1", root: "/private data/auth", point: "/run/bootstrap" });
  assert.throws(() => parseSubscriptionMountInfo("malformed"), /mount identity/);
});

test("trusted realm paths reject directory, descendant and single-link file bind aliases", {
  skip: process.platform !== "linux" || process.env.DAIMON_TEST_BIND_MOUNTS !== "1"
}, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "subscription-bind-")));
  const workspacePath = path.join(root, "workspace"), runtimeHomePath = path.join(root, "home");
  const durablePath = path.join(root, "realm"), bootstrapPath = path.join(root, "bootstrap");
  const directoryAlias = path.join(root, "directory-alias"), fileAlias = path.join(root, "file-alias");
  const agent: OrganizationRuntimeAgentConfig = { id: "test", name: "Test", instructions: "Work", workspacePath, runtimeHomePath, engine: { kind: "codex" } };
  for (const directory of [workspacePath, runtimeHomePath, durablePath, directoryAlias]) await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(workspacePath, "nested-realm"), { mode: 0o700 });
  for (const file of [bootstrapPath, fileAlias, path.join(workspacePath, "auth")]) await writeFile(file, "fixture", { mode: 0o600 });
  const mounted: string[] = [];
  const bind = (source: string, target: string): void => { execFileSync("mount", ["--bind", source, target]); mounted.push(target); };
  try {
    await prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath } }, [agent]);
    bind(workspacePath, directoryAlias);
    for (const candidate of [directoryAlias, path.join(directoryAlias, "nested-realm")]) {
      await assert.rejects(prepareSubscriptionRealmPaths({ codex: { bootstrapPath, durablePath: candidate } }, [agent]), /overlap/);
    }
    bind(path.join(workspacePath, "auth"), fileAlias);
    assert.equal((await lstat(fileAlias)).nlink, 1);
    await assert.rejects(prepareSubscriptionRealmPaths({ codex: { bootstrapPath: fileAlias, durablePath } }, [agent]), /overlap/);
  } finally {
    for (const target of mounted.reverse()) execFileSync("umount", [target]);
    await rm(root, { recursive: true, force: true });
  }
});
