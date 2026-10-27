import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../contracts/canonicalJson.js";
import { RUNTIME_CONTRACT_MANIFEST } from "../contracts/runtimeContractManifest.js";

test("manifest v7 pins the canonical emitted bytes including engine descriptors", () => {
  const bytes = `${canonicalJson(RUNTIME_CONTRACT_MANIFEST)}\n`;
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    "sha256:85de96d75cf1e02e0e88bd6e1dcce39a125c1d5b97f1eb9c01911a0d5c3316e8");
});
