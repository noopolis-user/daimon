import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import { startCodexSubscriptionRealm } from "../engines/codex/codexSubscriptionRealm.js";
import { startGrokSubscriptionRealm } from "../engines/grok/broker/grokSubscriptionRealm.js";

const engines = {
  codex: { title: "Codex", start: startCodexSubscriptionRealm,
    credential: (generation: string) => JSON.stringify({ tokens: { access_token: `access-${generation}`, refresh_token: `refresh-${generation}` } }) },
  grok: { title: "Grok", start: startGrokSubscriptionRealm,
    credential: (generation: string) => JSON.stringify({ "https://auth.x.ai::test": { key: `access-${generation}`, refresh_token: `refresh-${generation}`, expires_at: "2099-01-01T00:00:00.000Z" } }) }
} as const;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const writePrivate = async (file: string, value: string) => { await writeFile(file, value, { mode: 0o600 }); await chmod(file, 0o600); };

for (const [engine, profile] of Object.entries(engines)) {
  const unavailable = `${profile.title} subscription credential realm is unavailable or stale`;
  async function fixture(settings: { realFlock?: boolean } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), `daimon-${engine}-realm-`));
    const durablePath = path.join(root, "realm"), bootstrapPath = path.join(root, "bootstrap-auth"), flock = path.join(root, "fake-flock");
    await mkdir(durablePath, { mode: 0o700 });
    await writePrivate(bootstrapPath, profile.credential("bootstrap"));
    await writeFile(flock, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const options = { bootstrapPath, durablePath, ...(settings.realFlock ? {} : { flock }) };
    return { root, durablePath, bootstrapPath, start: () => profile.start(options), close: () => rm(root, { recursive: true, force: true }) };
  }

  test(`${engine}: the holder reads, replaces and keeps its authority across restart`, async () => {
    const f = await fixture();
    try {
      let realm = await f.start();
      const first = await realm.authority.read();
      assert.equal(first.toString("utf8"), profile.credential("bootstrap"));
      await realm.authority.replace(Buffer.from(profile.credential("refreshed")));
      await realm.close();
      assert.throws(() => realm.authority.assertLive(), new RegExp(unavailable, "u"));
      realm = await f.start();
      assert.equal((await realm.authority.read()).toString("utf8"), profile.credential("refreshed"));
      await realm.close();
    } finally { await f.close(); }
  });

  test(`${engine}: a stale fence holds until the operator supplies a new bootstrap`, async () => {
    const f = await fixture();
    try {
      let realm = await f.start();
      await realm.authority.markStale();
      await assert.rejects(realm.authority.read(), new RegExp(unavailable, "u"));
      await realm.close();
      await assert.rejects(f.start(), new RegExp(unavailable, "u"));
      await rm(path.join(f.durablePath, "auth.json"));
      await assert.rejects(f.start(), new RegExp(unavailable, "u"), "an unchanged revoked bootstrap is never reimported");
      await writePrivate(f.bootstrapPath, profile.credential("operator-renewed"));
      realm = await f.start();
      assert.equal((await realm.authority.read()).toString("utf8"), profile.credential("operator-renewed"));
      await realm.close();
    } finally { await f.close(); }
  });

  test(`${engine}: a replaced bootstrap is imported without relying on timestamps`, async () => {
    const f = await fixture();
    try {
      let realm = await f.start();
      await realm.authority.replace(Buffer.from(profile.credential("runtime-rotation")));
      await realm.close();
      await writePrivate(f.bootstrapPath, profile.credential("operator-replacement"));
      realm = await f.start();
      assert.equal((await realm.authority.read()).toString("utf8"), profile.credential("operator-replacement"));
      await realm.close();
    } finally { await f.close(); }
  });

  test(`${engine}: a pre-gateway lease journal is settled or fenced without an agent copy`, async () => {
    for (const [state, expectStale] of [["promoted", false], ["preparing", false], ["active", true], ["promoting", true]] as const) {
      const f = await fixture();
      try {
        await (await f.start()).close();
        const source = digest(profile.credential("bootstrap"));
        await writePrivate(path.join(f.durablePath, "lease.json"), JSON.stringify({ agent_id: "retired-agent", source_digest: source,
          ...(state === "promoted" || state === "promoting" ? { promoted_digest: source } : {}), state, version: `noopolis.daimon.${engine}-credential-lease.v1` }));
        if (expectStale) await assert.rejects(f.start(), new RegExp(unavailable, "u"), state);
        else await (await f.start()).close();
        await assert.rejects(lstat(path.join(f.durablePath, "lease.json")), { code: "ENOENT" });
      } finally { await f.close(); }
    }
  });

  test(`${engine}: startup removes only owned credential temporaries`, async () => {
    const f = await fixture();
    const name = ".auth.json.11111111-2222-4333-8444-555555555555.tmp";
    try {
      await writePrivate(path.join(f.durablePath, name), "partial credential");
      await writePrivate(path.join(f.durablePath, ".unrelated.tmp"), "retain");
      await (await f.start()).close();
      await assert.rejects(lstat(path.join(f.durablePath, name)), { code: "ENOENT" });
      assert.equal(await readFile(path.join(f.durablePath, ".unrelated.tmp"), "utf8"), "retain");
    } finally { await f.close(); }
  });

  test(`${engine}: replaced control metadata and linked authority fail closed without echoing contents`, async () => {
    for (const tamper of ["control", "link"] as const) {
      const f = await fixture();
      try {
        await (await f.start()).close();
        if (tamper === "control") {
          const outside = path.join(f.root, "outside-control");
          await writePrivate(outside, "secret-control-canary");
          await rm(path.join(f.durablePath, "bootstrap.json"));
          await symlink(outside, path.join(f.durablePath, "bootstrap.json"));
        } else await link(path.join(f.durablePath, "auth.json"), path.join(f.root, "linked-authority-canary"));
        await assert.rejects(f.start(), (error: Error) => {
          assert.equal(error.message, unavailable);
          assert.doesNotMatch(error.message, /canary|outside-control/u);
          return true;
        });
      } finally { await f.close(); }
    }
  });

  test(`${engine}: the bootstrap is held to the descriptor's exact byte ceiling`, async () => {
    const limit = ENGINE_DESCRIPTORS[engine as keyof typeof engines].auth.realm.maxCredentialBytes;
    for (const [size, accepted] of [[limit, true], [limit + 1, false]] as const) {
      const f = await fixture();
      try {
        await writePrivate(f.bootstrapPath, profile.credential("bounded").padEnd(size));
        if (accepted) await (await f.start()).close();
        else await assert.rejects(f.start(), new RegExp(unavailable, "u"));
      } finally { await f.close(); }
    }
  });

  test(`${engine}: one holder at a time`, { skip: process.platform !== "linux" }, async () => {
    const f = await fixture({ realFlock: true });
    try {
      const first = await f.start();
      await assert.rejects(f.start(), new RegExp(unavailable, "u"));
      await first.close();
      await (await f.start()).close();
    } finally { await f.close(); }
  });
}
