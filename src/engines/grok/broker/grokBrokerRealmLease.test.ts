import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireGrokBrokerRealmLease } from "./grokBrokerRealmLease.js";

test("broker realm lease excludes a second broker and releases on close",{skip:spawnSync("flock",["--version"]).error!==undefined},async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"grok-broker-lease-"));try{const first=await acquireGrokBrokerRealmLease(root);await assert.rejects(acquireGrokBrokerRealmLease(root),/already in use/u);await first.close();const replacement=await acquireGrokBrokerRealmLease(root);await replacement.close();}finally{await rm(root,{recursive:true,force:true});}});

test("broker keeps the account leased if its helper dies before owner shutdown", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-broker-owner-"));
  const wrapper = path.join(root, "flock-wrapper");
  const pidFile = path.join(root, "helper-pid");
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$PPID" > '${pidFile}'\nexec flock "$@"\n`, { mode: 0o700 });
  const first = await acquireGrokBrokerRealmLease(root, wrapper);
  try {
    process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(acquireGrokBrokerRealmLease(root), /already in use/u);
    await first.close();
    const next = await acquireGrokBrokerRealmLease(root);
    await next.close();
  } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
});
