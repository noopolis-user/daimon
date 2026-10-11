import assert from "node:assert/strict";
import {
  chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GROK_BROKER_TASK_CLOCK } from "../contracts/grokBrokerTaskClock.js";
import { assertBrokerTaskClockDirectory, assertBrokerTaskClockSlot, brokerProcessClock, prepareBrokerTaskClock, writeBrokerTaskClock } from "./grokBrokerTaskClock.js";
import { taskClockChildEnvironment } from "./taskClock.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-broker-clock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "clock");
  await mkdir(directory, { mode: 0o755 }); await chmod(directory, 0o755);
  return { root, directory, file: path.join(directory, "faketime"), uid: process.getuid!() };
}

test("broker process clock uses the existing exact-millisecond derivation and the pinned preload", (t) => {
  const prior = process.env;
  process.env = { NOOPOLIS_TASK_CLOCK: '{"version":"noopolis.task-clock.v1","origin":"2001-01-01T00:00:00Z","anchorEpochMs":1821692800250}', LD_PRELOAD: "/unrelated.so", FAKETIME: "+123" };
  t.after(() => { process.env = prior; });
  assert.equal(brokerProcessClock(), "-843385600.250");
  assert.equal(brokerProcessClock(), taskClockChildEnvironment({}, undefined, { LD_PRELOAD: GROK_BROKER_TASK_CLOCK.preloadPath }).FAKETIME);
  delete process.env.NOOPOLIS_TASK_CLOCK;
  assert.equal(brokerProcessClock(), undefined);
});

test("publication replaces an inode atomically, preserves exact milliseconds, and resets to real time", async (t) => {
  const { directory, file, uid } = await fixture(t);
  await writeBrokerTaskClock("-843385600.250", file, uid);
  const old = await open(file, "r");
  try {
    const previous = await old.stat();
    const mask = process.umask(0o077);
    try { await writeBrokerTaskClock("+0.001", file, uid); } finally { process.umask(mask); }
    assert.equal(await old.readFile("utf8"), "-843385600.250\n", "an already open reader must retain the complete previous value");
    const current = await lstat(file);
    assert.notEqual(current.ino, previous.ino, "must rename a new inode, never truncate in place");
    assert.equal(current.uid, uid);
    assert.equal(current.mode & 0o777, 0o644, "worker gets read, never write, even under broker umask 077");
    assert.equal(await readFile(file, "utf8"), "+0.001\n");
    await writeBrokerTaskClock(undefined, file, uid);
    assert.equal(await readFile(file, "utf8"), "+0\n");
    assert.deepEqual(await readdir(directory), ["faketime"]);
  } finally { await old.close(); }
});

test("publication refuses unsafe directories and never follows a destination symlink", async (t) => {
  const { root, directory, file, uid } = await fixture(t);
  for (const mode of [0o775, 0o777, 0o700]) {
    await chmod(directory, mode);
    await assert.rejects(writeBrokerTaskClock("+1", file, uid), /unsafe/u);
  }
  await chmod(directory, 0o755);
  await assert.rejects(writeBrokerTaskClock("+1", file, uid + 1), /unsafe/u);
  const link = path.join(root, "link"); await symlink(directory, link);
  await assert.rejects(writeBrokerTaskClock("+1", path.join(link, "faketime"), uid), /unsafe/u);
  const target = path.join(root, "keep"); await writeFile(target, "untouched"); await symlink(target, file);
  await writeBrokerTaskClock("+2", file, uid);
  assert.equal(await readFile(target, "utf8"), "untouched");
  assert.equal((await lstat(file)).isSymbolicLink(), false);
  await assert.rejects(writeBrokerTaskClock("@2000-01-01", file, uid), /process clock/u);
  assert.equal(await readFile(file, "utf8"), "+2\n");
});

test("publication fsyncs the file before rename and the parent after rename", async (t) => {
  const { directory, file, uid } = await fixture(t);
  await writeFile(file, "+999\n");
  const operations: string[] = [];
  await writeBrokerTaskClock("-1.234", file, uid, {
    lstat, unlink,
    open: async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        operations.push(args[0] === directory ? "directory:sync" : "file:sync");
        await sync();
      });
      return handle;
    },
    rename: async (source, target) => {
      operations.push("rename");
      assert.equal(await readFile(file, "utf8"), "+999\n");
      await rename(source, target);
    }
  });
  assert.deepEqual(operations, ["file:sync", "rename", "directory:sync"]);
  assert.equal(await readFile(file, "utf8"), "-1.234\n");
});

test("provisioning admits only broker ownership, worker-readable modes and one clocked registration", () => {
  assert.equal(GROK_BROKER_TASK_CLOCK.ownerUid, 2100);
  assert.equal(GROK_BROKER_TASK_CLOCK.directoryMode, 0o755);
  assert.equal(GROK_BROKER_TASK_CLOCK.fileMode, 0o644);
  assertBrokerTaskClockDirectory({ uid: 2100, mode: 0o755, isDirectory: () => true });
  assert.throws(() => assertBrokerTaskClockDirectory({ uid: 2200, mode: 0o755, isDirectory: () => true }), /unsafe/u);
  assertBrokerTaskClockSlot("clocked", 1);
  assert.throws(() => assertBrokerTaskClockSlot("clocked", 2), /one registration/u);
  assertBrokerTaskClockSlot("unclocked", 32);
});

test("only a clock request on an attested unclocked config emits the gap, without clock I/O", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const written: (string | undefined)[] = [];
  const write = async (value: string | undefined) => { written.push(value); };
  assert.equal(await prepareBrokerTaskClock("unclocked", "-1.234", write), "gap");
  assert.equal(warning.mock.callCount(), 1);
  assert.match(warning.mock.calls[0]!.arguments[0], /attested broker worker config is unclocked.*wake allowed/u);
  assert.equal(await prepareBrokerTaskClock("unclocked", undefined, write), "real");
  assert.deepEqual(written, []);
  assert.equal(await prepareBrokerTaskClock("clocked", "-1.234", write), "task");
  assert.equal(await prepareBrokerTaskClock("clocked", undefined, write), "real");
  assert.deepEqual(written, ["-1.234", undefined]);
  assert.equal(warning.mock.callCount(), 1);
});
