/** Snapshot Spawnfile's parser as test data, without importing its implementation. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const files = [
  "src/runtime/daimon/contractManifest.ts",
  "src/runtime/daimon/contractManifestSchema.ts",
  "src/runtime/daimon/engineDescriptorSchema.ts",
  "src/runtime/daimon/engineDescriptors.generated.ts",
  "src/runtime/daimon/contract-manifest.json",
  "src/runtime/daimon/wakeMoments.ts",
  "src/shared/errors.ts"
] as const;
const [checkout, ref, check] = process.argv.slice(2);
if (!checkout || !path.isAbsolute(checkout) || !ref || (check !== undefined && check !== "--check") || process.argv.length > 5) {
  throw new Error("usage: vendorSpawnfileContractParser.ts /absolute/spawnfile-checkout ref [--check]");
}
const env = { ...process.env };
delete env.TYPESAFE_API_KEY;
const git = (...args: string[]): string => execFileSync("git", ["-C", checkout, ...args], {
  encoding: "utf8", env, maxBuffer: 2 * 1024 * 1024
});
const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Spawnfile fixture requires an exact full commit");
const fixture = {
  repository: "https://github.com/noopolis/spawnfile",
  commit,
  files: Object.fromEntries(files.map((filename) => {
    const source = git("show", `${commit}:${filename}`);
    return [filename, { sha256: createHash("sha256").update(source).digest("hex"), source }];
  }))
};
const destination = new URL("../src/runtime/fixtures/spawnfile-contract-parser.json", import.meta.url);
const bytes = `${JSON.stringify(fixture, null, 2)}\n`;
if (check === "--check") {
  if (readFileSync(destination, "utf8") !== bytes) throw new Error("Spawnfile parser fixture drifted from its Git pin");
} else writeFileSync(destination, bytes);
process.stdout.write(`Spawnfile parser fixture ${check ? "matches" : "vendored from"} ${commit}\n`);
