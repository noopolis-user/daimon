import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_DESCRIPTORS, ENGINE_IDS } from "../engines/descriptors.js";
import type { RuntimeHostResources } from "../engines/runtimeHooks.js";
import { assertSubscriptionAuthority } from "./subscriptionAuthority.js";

test("every supported subscription descriptor requires its actual production owner", () => {
  const realm = { withCredential: async <T>(_agent: unknown, operation: () => Promise<T>) => operation(), close: async () => {} };
  const resources: RuntimeHostResources = { credentialRealms: { agy: realm }, subscriptionBrokers: { grok: { turn: async () => "" } } };
  const gateway = { DAIMON_GATEWAY_URL: "http://127.0.0.1:43200", DAIMON_GATEWAY_KEY: "a".repeat(64) };
  for (const engine of ENGINE_IDS) {
    assert.throws(() => assertSubscriptionAuthority(engine, {}, {}), /requires its shared runtime credential authority/);
    assert.doesNotThrow(() => assertSubscriptionAuthority(engine, resources, gateway));
    const portable = ENGINE_DESCRIPTORS[engine].auth.staging === "portable-realm";
    assert.throws(() => portable ? assertSubscriptionAuthority(engine, resources, {})
      : assertSubscriptionAuthority(engine, engine === "grok" ? { ...resources, subscriptionBrokers: undefined } : { ...resources, credentialRealms: {} }, gateway),
    /requires its shared runtime credential authority/);
  }
});
