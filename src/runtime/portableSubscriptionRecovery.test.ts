import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startCodexSubscriptionRealm } from "../engines/codex/codexSubscriptionRealm.js";

const credential = (value: string) => JSON.stringify({ tokens: { access_token: `access-${value}`, refresh_token: `refresh-${value}` } });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const privateWrite = (file: string, text: string) => writeFile(file, text, { mode: 0o600 });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-recovery-"));
  const durablePath = path.join(root, "realm");
  const bootstrapPath = path.join(root, "bootstrap");
  const agent = { id: "test", runtimeHomePath: path.join(root, "home") };
  const engineHome = path.join(agent.runtimeHomePath, ".codex");
  const target = path.join(engineHome, "auth.json");
  const journal = path.join(durablePath, "lease.json");
  const flock = path.join(root, "flock");
  await mkdir(durablePath, { mode: 0o700 });
  await mkdir(engineHome, { recursive: true, mode: 0o700 });
  await privateWrite(bootstrapPath, credential("source"));
  await privateWrite(path.join(durablePath, "auth.json"), credential("source"));
  await writeFile(flock, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const options = { durablePath, bootstrapPath, flock };
  return { root, durablePath, bootstrapPath, agent, engineHome, target, journal, options,
    start: () => startCodexSubscriptionRealm([agent], options), close: () => rm(root, { recursive: true, force: true }) };
}

test("mismatched promoting candidate is removed before fencing and changed bootstrap can recover", async () => {
  const f = await fixture();
  await privateWrite(f.target, credential("unexpected"));
  await privateWrite(f.journal, JSON.stringify({ version: "noopolis.daimon.codex-credential-lease.v1", agent_id: f.agent.id, state: "promoting", source_digest: digest(credential("source")), promoted_digest: digest(credential("expected")) }));
  try {
    await assert.rejects(f.start(), /unavailable or stale/);
    await assert.rejects(lstat(f.target), { code: "ENOENT" });
    await privateWrite(f.bootstrapPath, credential("reenrolled"));
    const realm = await f.start();
    try { await realm.withCredential(f.agent, async () => assert.equal(await readFile(f.target, "utf8"), credential("reenrolled"))); }
    finally { await realm.close(); }
  } finally { await f.close(); }
});

test("preparing recovery syncs staged removal while its journal still exists", async (t) => {
  const f = await fixture();
  await privateWrite(f.target, credential("source"));
  await privateWrite(f.journal, JSON.stringify({ version: "noopolis.daimon.codex-credential-lease.v1", agent_id: f.agent.id, state: "preparing", source_digest: digest(credential("source")) }));
  const directory = await open(f.engineHome, "r");
  const identity = await directory.stat();
  const prototype = Object.getPrototypeOf(directory) as FileHandle;
  const original = prototype.sync;
  await directory.close();
  let removalSyncedBeforeJournalCleared = false;
  t.mock.method(prototype, "sync", async function(this: FileHandle) {
    const entry = await this.stat();
    if (entry.dev === identity.dev && entry.ino === identity.ino) {
      await assert.rejects(lstat(f.target), { code: "ENOENT" });
      assert.equal(JSON.parse(await readFile(f.journal, "utf8")).state, "preparing");
      removalSyncedBeforeJournalCleared = true;
    }
    return original.call(this);
  });
  try {
    const realm = await f.start();
    await realm.close();
    assert.equal(removalSyncedBeforeJournalCleared, true);
    await assert.rejects(lstat(f.journal), { code: "ENOENT" });
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("startup removes only owned credential temporaries left by interrupted atomic writes", async () => {
  const f = await fixture();
  const name = ".auth.json.11111111-2222-4333-8444-555555555555.tmp";
  try {
    for (const directory of [f.durablePath, f.engineHome]) {
      await privateWrite(path.join(directory, name), "partial credential");
      await privateWrite(path.join(directory, ".unrelated.tmp"), "retain");
    }
    const realm = await f.start();
    await realm.close();
    for (const directory of [f.durablePath, f.engineHome]) {
      await assert.rejects(lstat(path.join(directory, name)), { code: "ENOENT" });
      assert.equal(await readFile(path.join(directory, ".unrelated.tmp"), "utf8"), "retain");
    }
    await symlink(f.bootstrapPath, path.join(f.engineHome, name));
    await assert.rejects(f.start(), /unavailable or stale/);
    assert.equal(await readFile(f.bootstrapPath, "utf8"), credential("source"));
  } finally { await f.close(); }
});
