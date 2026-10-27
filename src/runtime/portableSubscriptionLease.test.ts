import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startCodexSubscriptionRealm } from "../engines/codex/codexSubscriptionRealm.js";
import { startGrokSubscriptionRealm } from "../engines/grok/broker/grokSubscriptionRealm.js";
import type { PortableSubscriptionRealm } from "./portableSubscriptionRealmTypes.js";

for (const engine of ["codex", "grok"] as const) {
  test(`${engine} retains the account lock after its lease helper dies until the active turn drains`, { skip: process.platform !== "linux" }, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "portable-realm-owner-")));
    const durablePath = path.join(root, "realm");
    const bootstrapPath = path.join(root, "bootstrap");
    const runtimeHomePath = path.join(root, "home");
    const wrapper = path.join(root, "flock-wrapper");
    const pidFile = path.join(root, "helper-pid");
    await mkdir(durablePath, { mode: 0o700 });
    await mkdir(path.join(runtimeHomePath, `.${engine}`), { recursive: true, mode: 0o700 });
    const auth = engine === "codex" ? { tokens: { access_token: "access-test", refresh_token: "refresh-test" } }
      : { "https://auth.x.ai::test": { expires_at: "2099-01-01T00:00:00.000Z", key: "access-test", refresh_token: "refresh-test" } };
    await writeFile(bootstrapPath, JSON.stringify(auth), { mode: 0o600 });
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$PPID" > '${pidFile}'\nexec flock "$@"\n`, { mode: 0o700 });
    const agent = { id: "owner", name: "Owner", instructions: "Work.", runtimeHomePath, workspacePath: root, engine: { kind: "grok" as const } };
    const options = { durablePath, bootstrapPath, flock: wrapper };
    const start = () => engine === "codex" ? startCodexSubscriptionRealm([agent], options) : startGrokSubscriptionRealm([agent], options);
    const realm = await start();
    let unexpected: PortableSubscriptionRealm | undefined;
    let release!: () => void;
    let began!: () => void;
    const entered = new Promise<void>((resolve) => { began = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const active = realm.withCredential(agent, async () => { began(); await held; return "finished"; });
    try {
      await entered;
      const pid = Number(await readFile(pidFile, "utf8"));
      process.kill(pid, "SIGKILL");
      await waitUntilGone(pid);
      await assert.rejects(async () => { unexpected = await start(); }, /credential realm is unavailable or stale/u);
      await assert.rejects(Promise.race([
        realm.withCredential(agent, async () => assert.fail("dead owner admitted work")),
        new Promise((_, reject) => setTimeout(() => reject(new Error("dead owner did not reject")), 200))
      ]), /credential realm is unavailable or stale/u);
      release();
      assert.equal(await active, "finished");
      // Closing drains the operation before releasing the parent's retained fd.
      await realm.close();
      const next = await start();
      await next.close();
    } finally {
      release();
      await active.catch(() => undefined);
      await unexpected?.close();
      await realm.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch { await new Promise((resolve) => setImmediate(resolve)); return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("lease helper did not terminate");
}
