import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { grokWorkerToolProcessLive, grokWorkerToolProcessSampler } from "./grokWorkerToolProcess.js";

const ENGINE = ["--sandbox", "daimon-strict", "--always-approve", "--cwd", "/workspace", "--output-format", "streaming-messages-json", "--model", "daimon-broker-grok"];

/** A `/proc` fixture: the process tree a live Grok 1.0.34 worker showed in the training image while it ran `sleep`. */
async function withProc(run: (proc: (pid: number, uid: number, parent: number, argv: readonly string[], state?: string) => Promise<void>, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-tool-proc-"));
  try {
    await run(async (pid, uid, parent, argv, state = "S (sleeping)") => {
      await mkdir(path.join(root, String(pid)));
      await writeFile(path.join(root, String(pid), "status"), `Name:\tx\nState:\t${state}\nPPid:\t${parent}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
      await writeFile(path.join(root, String(pid), "cmdline"), `${argv.join("\0")}\0`);
    }, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("a tool child of the worker's engine process is live work; the engine processes alone are not", async () => {
  await withProc(async (proc, root) => {
    await proc(53, 0, 1, ["/opt/daimon/bin/daimon-engine-broker"]);
    // Grok re-executes into bubblewrap; both carry the compiled argv.
    await proc(79, 2_200, 53, ["bwrap", "--cap-drop", "ALL", "--", "/usr/local/bin/grok", ...ENGINE]);
    await proc(105, 2_200, 79, ["/usr/local/bin/grok", ...ENGINE]);
    assert.equal(await grokWorkerToolProcessLive(2_200, root), false, "an idle worker has only its engine processes");
    await proc(163, 2_200, 105, ["/usr/bin/bash", "-O", "extglob", "-c", "sleep 900"]);
    await proc(167, 2_200, 163, ["sleep", "900"]);
    assert.equal(await grokWorkerToolProcessLive(2_200, root), true);
    assert.equal(await grokWorkerToolProcessLive(2_201, root), false, "another identity's tree is not this worker's");
  });
});

test("a zombie, another uid's child, or an unreadable /proc is not a live tool", async () => {
  await withProc(async (proc, root) => {
    await proc(79, 2_200, 53, ["bwrap", "--", "/usr/local/bin/grok", ...ENGINE]);
    await proc(105, 2_200, 79, ["/usr/local/bin/grok", ...ENGINE]);
    await proc(163, 2_200, 105, ["/usr/bin/bash", "-c", "true"], "Z (zombie)");
    await proc(170, 2_201, 105, ["/usr/bin/bash", "-c", "sleep 900"]);
    assert.equal(await grokWorkerToolProcessLive(2_200, root), false);
  });
  assert.equal(await grokWorkerToolProcessLive(2_200, path.join(os.tmpdir(), "daimon-no-such-proc")), false);
});

test("a worker process without the compiled argv is not an engine, so its children are not counted", async () => {
  await withProc(async (proc, root) => {
    await proc(105, 2_200, 1, ["/usr/local/bin/grok", "--output-format", "json"]);
    await proc(163, 2_200, 105, ["sleep", "900"]);
    assert.equal(await grokWorkerToolProcessLive(2_200, root), false);
  });
});

test("the sampler keeps the last completed read, never overlaps reads, and reads a failure as no tool", async () => {
  let resolve: ((value: boolean) => void) | undefined, reads = 0;
  const sampler = grokWorkerToolProcessSampler(() => { reads += 1; return new Promise<boolean>((done) => { resolve = done; }); });
  assert.equal(sampler.live(), false);
  sampler.poll(); sampler.poll();
  await new Promise((done) => setImmediate(done));
  assert.equal(reads, 1, "a pending read is not duplicated");
  resolve!(true); await new Promise((done) => setImmediate(done));
  assert.equal(sampler.live(), true);
  const failing = grokWorkerToolProcessSampler(() => { throw new Error("EACCES"); });
  failing.poll(); await new Promise((done) => setImmediate(done));
  assert.equal(failing.live(), false);
});
