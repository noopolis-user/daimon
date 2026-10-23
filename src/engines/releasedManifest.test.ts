import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../contracts/canonicalJson.js";
import { RUNTIME_CONTRACT_MANIFEST } from "../contracts/runtimeContractManifest.js";

test("manifest v6 pins the canonical emitted bytes including engine descriptors", () => {
  const bytes = `${canonicalJson(RUNTIME_CONTRACT_MANIFEST)}\n`;
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    "sha256:9f91388983cc5308137ba0259302b9faec75a9f0e032b2a031b6a774ff3f409f");
});
