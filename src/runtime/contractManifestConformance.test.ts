import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import { canonicalJson, canonicalRuntimeContractManifest } from "./contractManifest.js";

type Manifest = Record<string, any>;
interface Fixture {
  repository: string;
  commit: string;
  files: Record<string, { sha256: string; source: string }>;
}
interface SpawnfileParser {
  parseDaimonContractManifest(value: unknown): Manifest;
  readVerifiedDaimonContractManifest(root: string): Promise<{ digest: string; manifest: Manifest }>;
}

test("emitted v7 artifacts conform to the pinned Spawnfile parser and reject contract drift", async () => {
  // Raw upstream sources stay JSON test data, outside the production module graph.
  // Materialize the unchanged closure only for this test; no sibling checkout/network needed.
  const fixture: Fixture = JSON.parse(await readFile(new URL("./fixtures/spawnfile-contract-parser.json", import.meta.url), "utf8"));
  assert.equal(fixture.repository, "https://github.com/noopolis/spawnfile");
  assert.match(fixture.commit, /^[a-f0-9]{40}$/u);
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(path.resolve(".runtime/spawnfile-conformance-"));
  try {
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
    for (const [filename, { source, sha256 }] of Object.entries(fixture.files)) {
      assert.equal(createHash("sha256").update(source).digest("hex"), sha256, filename);
      assert.ok(filename.startsWith("src/") && !filename.split("/").includes(".."));
      const destination = path.join(root, filename);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, source);
    }
    const parser: SpawnfileParser = await import(pathToFileURL(path.join(root, "src/runtime/daimon/contractManifest.ts")).href);
    const output = path.join(root, "emitted");
    await mkdir(output);
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      'import { emitContractManifestArtifacts } from "./scripts/emitRuntimeContractManifest.ts"; await emitContractManifestArtifacts(process.argv[1]);', output
    ], { env, timeout: 30_000 });
    const bytes = await readFile(path.join(output, "contract-manifest.json"), "utf8");
    assert.equal(bytes, `${canonicalRuntimeContractManifest()}\n`);
    const emitted: Manifest = JSON.parse(bytes);
    assert.equal(emitted.version, "noopolis.daimon.runtime-contract-manifest.v7");
    assert.deepEqual(emitted.engines, ENGINE_DESCRIPTORS);
    const verified = await parser.readVerifiedDaimonContractManifest(output);
    assert.equal(verified.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    assert.equal(verified.manifest.version, emitted.version);
    assert.deepEqual(verified.manifest.engines, emitted.engines);
    assert.deepEqual(verified.manifest.supportedEngineKinds, Object.keys(emitted.engines).sort());

    const rejects = (label: string, mutate: (manifest: Manifest) => void): void => {
      const changed = structuredClone(emitted);
      mutate(changed);
      assert.throws(() => parser.parseDaimonContractManifest(changed), /Daimon runtime contract manifest/, label);
    };
    rejects("missing Codex realm", m => { delete m.codexSubscriptionRealm; });
    rejects("Codex realm drift", m => { m.codexSubscriptionRealm.fileMode = 0o644; });
    rejects("Codex staging drift", m => { m.engines.codex.auth.staging = "portable-file"; });
    rejects("missing inventory", m => { delete m.engines; });
    rejects("missing v5 section", m => { delete m.healthResponseSchema; });
    rejects("unsupported version", m => { m.version = "noopolis.daimon.runtime-contract-manifest.v8"; });
    rejects("unsorted supported kinds", m => { m.supportedEngineKinds.reverse(); });
    rejects("descriptor key/id mismatch", m => { m.engines.codex.id = "other"; });
    rejects("unknown descriptor member", m => { m.engines.codex.unknown = true; });
    rejects("credential parity", m => { m.engines.codex.credentialMaterial.sourceSlot = "other-auth"; });
    rejects("legacy credential drift", m => { m.engineCredentialMaterial.codex.fileMode = 0o644; });
    rejects("legacy broker drift", m => { m.grokEngineBroker.worker.defaultModel = "other"; });
    rejects("descriptor broker drift", m => { m.engines.grok.broker.worker.defaultModel = "other"; });
    rejects("legacy broker realm drift", m => { m.grokSubscriptionRealm.fileMode = 0o644; });
    rejects("legacy secret service realm drift", m => { m.agySubscriptionRealm.fileMode = 0o644; });
    // Object key ordering must not turn equivalent legacy/descriptor data into drift.
    const reordered = structuredClone(emitted);
    reordered.engineCredentialMaterial.codex = Object.fromEntries(Object.entries(reordered.engineCredentialMaterial.codex).reverse());
    assert.equal(canonicalJson(parser.parseDaimonContractManifest(reordered)), canonicalJson(verified.manifest));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
