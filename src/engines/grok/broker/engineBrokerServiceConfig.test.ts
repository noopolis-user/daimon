import assert from "node:assert/strict";
import test from "node:test";

import { parseEngineBrokerServiceConfig } from "./engineBrokerServiceConfig.js";

const paths = { credentialHome: "/var/lib/daimon-engine-broker/credential", turnStore: "/var/lib/daimon-engine-broker/turns" };
const reg = (slot: number) => ({ agentId: "agent", slot, workerUid: 2200 + slot, workspace: `/workspace/${slot}`, profilePath: `/workers/${slot}/.grok/sandbox.toml`, eventsPath: `/workers/${slot}/.grok/sessions/sandbox-events.jsonl`, profileSha256: "a".repeat(64) });
const policy = (slot: number) => ({ usageLedgerPath: `/run/slots/${slot}/usage/usage.jsonl`, limits: { maxRequests: 12, maxTokens: 400_000, timeoutMs: 480_000 }, model: { id: "grok-4.6", reasoningEffort: "low" } });
const v2 = (registration: Record<string, unknown>) => ({ version: "noopolis.daimon.engine-broker-service.v2", ...paths, registrations: [registration] });
const v3 = (slotPolicy: Record<string, unknown>) => ({ version: "noopolis.daimon.engine-broker-service.v3", ...paths, registrations: [reg(0)], slotPolicies: [{ slot: 0, ...policy(0), ...slotPolicy }] });
const skillsSha256 = "b".repeat(64);

test("a v2 registration or v3 slot policy may declare the slot's skills digest", () => {
  assert.equal(parseEngineBrokerServiceConfig(v2({ ...reg(0), ...policy(0), skillsSha256 })).registrations[0]!.skillsSha256, skillsSha256);
  assert.equal(parseEngineBrokerServiceConfig(v3({ skillsSha256 })).registrations[0]!.skillsSha256, skillsSha256);
  // Omitted stays omitted: a skill-less registration parses exactly as before.
  assert.equal(Object.hasOwn(parseEngineBrokerServiceConfig(v2({ ...reg(0), ...policy(0) })).registrations[0]!, "skillsSha256"), false);
  assert.equal(Object.hasOwn(parseEngineBrokerServiceConfig(v3({})).registrations[0]!, "skillsSha256"), false);
});

test("refuses a malformed skills digest and one declared where the version has no slot for it", () => {
  for (const value of [
    v2({ ...reg(0), ...policy(0), skillsSha256: "B".repeat(64) }),
    v2({ ...reg(0), ...policy(0), skillsSha256: null }),
    v3({ skillsSha256: "short" }),
    { version: "noopolis.daimon.engine-broker-service.v1", ...paths, registrations: [{ ...reg(0), skillsSha256 }] },
    { ...v3({}), registrations: [{ ...reg(0), skillsSha256 }] }
  ]) assert.throws(() => parseEngineBrokerServiceConfig(value), /invalid engine broker service config/u);
});
