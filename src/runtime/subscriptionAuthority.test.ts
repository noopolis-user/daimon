import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_IDS } from "../engines/descriptors.js";
import type { RuntimeHostResources } from "../engines/runtimeHooks.js";
import { assertSubscriptionAuthority } from "./subscriptionAuthority.js";

test("every supported subscription descriptor requires its actual production owner", () => {
  const realm = { withCredential: async <T>(_agent: unknown, operation: () => Promise<T>) => operation(), close: async () => {} };
  const resources: RuntimeHostResources = {
    credentialRealms: { codex: realm, agy: realm },
    subscriptionBrokers: { grok: { turn: async () => "" } }
  };
  for (const engine of ENGINE_IDS) {
    assert.throws(() => assertSubscriptionAuthority(engine, {}), /requires its shared runtime credential authority/);
    assert.doesNotThrow(() => assertSubscriptionAuthority(engine, resources));
    const missing = engine === "grok" ? { ...resources, subscriptionBrokers: undefined }
      : { ...resources, credentialRealms: { ...resources.credentialRealms, [engine]: undefined } };
    assert.throws(() => assertSubscriptionAuthority(engine, missing), /requires its shared runtime credential authority/);
  }
});
