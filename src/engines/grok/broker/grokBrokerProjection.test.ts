import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_SUBSCRIPTION_REALM, GROK_ENGINE_BROKER, GROK_SUBSCRIPTION_REALM } from "../../../contracts/runtimeContractManifest.js";
import { parseEngineBrokerServiceConfig } from "./engineBrokerServiceConfig.js";
import { grokBrokerProjectionSha256, grokBrokerServiceRegistrationFor, resolveOrganizationGrokBrokerProjection, verifyGrokBrokerRegistrationMatchesProjection } from "./grokBrokerProjection.js";
import { grokBrokerWorkerConfigSha256 } from "./grokBrokerWorkerConfig.js";
import { grokWorkerSandboxProfileSha256 } from "./grokWorkerSandboxProfile.js";
import { grokWorkerSkillsSha256 } from "./grokWorkerSkills.js";

const agent = (id: string, engine: Record<string, unknown>) => ({ id, name: id, instructions: "Unused", workspacePath: `/var/lib/spawnfile/instance/workspace/agents/${id}`, runtimeHomePath: `/var/lib/spawnfile/instance/homes/${id}`, schedule: { kind: "disabled" }, engine });
const config = { version: "noopolis.daimon.organization-runtime.v2", host: { bindHost: "127.0.0.1", port: 19700, controlTokenEnv: "UNIT_CONTROL_TOKEN" },
  agents: [agent("foreman", { kind: "grok", model: "grok-4.6", reasoningEffort: "low" }), agent("peer", { kind: "codex" })] };
const options = { slot: 0, workerUid: 2_200, workerHomePath: "/var/lib/daimon-workers/2200", architecture: "arm64", usageLedgerPath: "/run/slots/0/usage/usage.jsonl",
  limits: { maxRequests: 24, maxTokens: 400_000, timeoutMs: 480_000 }, acceptanceStorePath: "/run/paideia/control", denyPaths: ["/run/paideia", "/run/training/inputs"], seccompProfileSha256: "7".repeat(64) } as const;

test("clocked projection binds the alternate config pin and the slot provisioning contract", () => {
  const plain = resolveOrganizationGrokBrokerProjection(config, "foreman", options);
  const clocked = resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, workerConfigVariant: "clocked" });
  assert.equal(clocked.workerConfigVariant, "clocked");
  assert.equal(clocked.workerConfigSha256, GROK_ENGINE_BROKER.worker.clockedConfigSha256["grok-4.6"].low);
  assert.deepEqual(clocked.taskClock, GROK_ENGINE_BROKER.worker.taskClock);
  assert.equal(plain.taskClock, undefined);
  assert.notEqual(grokBrokerProjectionSha256(plain), grokBrokerProjectionSha256(clocked));
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, workerConfigVariant: "clocked", denyPaths: ["/run/daimon-engine-broker"] }), /clock path is denied/u);
});

test("the projection is Daimon's own renderers and collectors, fully declared and deterministic", () => {
  const projection = resolveOrganizationGrokBrokerProjection(config, "foreman", options);
  const denyPaths = [CODEX_SUBSCRIPTION_REALM.bootstrapMountPath, CODEX_SUBSCRIPTION_REALM.durableMountPath, GROK_SUBSCRIPTION_REALM.bootstrapMountPath, GROK_SUBSCRIPTION_REALM.durableMountPath, "/run/paideia/control", "/var/lib/spawnfile/instance/homes/peer", "/var/lib/spawnfile/instance/workspace/agents/peer", "/run/paideia", "/run/training/inputs"].sort();
  assert.deepEqual(projection, {
    version: "noopolis.daimon.grok-broker-projection.v3", agentId: "foreman",
    workspacePath: "/var/lib/spawnfile/instance/workspace/agents/foreman", runtimeHomePath: "/var/lib/spawnfile/instance/homes/foreman",
    workerUid: 2_200, slot: 0, profilePath: "/var/lib/daimon-workers/2200/.grok/sandbox.toml", profileSha256: grokWorkerSandboxProfileSha256(denyPaths), denyPaths,
    workerConfigVariant: "unclocked", workerConfigSha256: grokBrokerWorkerConfigSha256({ model: "grok-4.6", reasoningEffort: "low" }), systemPromptSha256: GROK_ENGINE_BROKER.worker.systemPromptSha256,
    grokCliVersion: "1.0.34", grokExecutableSha256: GROK_ENGINE_BROKER.grokCliArtifacts.arm64.sha256, nativeAbiVersion: GROK_ENGINE_BROKER.nativeAbiVersion,
    model: "grok-4.6", reasoningEffort: "low", limits: options.limits, usageLedgerPath: options.usageLedgerPath,
    seccompProfileSha256: "7".repeat(64),
    attestation: { platform: "linux/landlock", enforced: true, restrictNetwork: true, profileName: "daimon-strict", sandboxRuntime: "bubblewrap", eventsPath: "/var/lib/daimon-workers/2200/.grok/sessions/sandbox-events.jsonl" }
  });
  assert.equal(grokBrokerProjectionSha256(resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, denyPaths: [...options.denyPaths].reverse() })), grokBrokerProjectionSha256(projection));
  assert.match(grokBrokerProjectionSha256(projection), /^[a-f0-9]{64}$/u);
});

test("the projection refuses undeclared models, non-Grok agents, and a profile digest it did not render", () => {
  assert.throws(() => resolveOrganizationGrokBrokerProjection({ ...config, agents: [agent("foreman", { kind: "grok" })] }, "foreman", options), /declared model/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "peer", options), /known Grok agent/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, seccompProfileSha256: "not-a-digest" }), /seccomp profile sha256/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "missing", options), /known Grok agent/u);
  // Mutation guard: skipping the digest comparison accepts a weaker profile's digest.
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, profileSha256: grokWorkerSandboxProfileSha256([]) }), /profile digest mismatch/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, denyPaths: ["relative"] }), /deny path/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, limits: { ...options.limits, maxRequests: 49 } }), /invalid/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, usageLedgerPath: "/run/slots/0/usage/requests.jsonl" }), /invalid engine broker service config/u);
  assert.equal(resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, profileSha256: resolveOrganizationGrokBrokerProjection(config, "foreman", options).profileSha256 }).agentId, "foreman");
});

test("a provisioned registration must describe its projection exactly", () => {
  const projection = resolveOrganizationGrokBrokerProjection(config, "foreman", options);
  const parse = (registration: Record<string, unknown>) => parseEngineBrokerServiceConfig({ version: "noopolis.daimon.engine-broker-service.v2", credentialHome: "/c", turnStore: "/t", registrations: [registration] }).registrations[0]!;
  const registration = grokBrokerServiceRegistrationFor(projection);
  verifyGrokBrokerRegistrationMatchesProjection(parse(registration), projection);
  for (const drift of [{ profileSha256: grokWorkerSandboxProfileSha256([]) }, { model: { id: "grok-4.5", reasoningEffort: "low" } }, { limits: { ...options.limits, maxTokens: 400_001 } }, { usageLedgerPath: "/run/slots/1/usage/usage.jsonl" }]) {
    assert.throws(() => verifyGrokBrokerRegistrationMatchesProjection(parse({ ...registration, ...drift }), projection), /does not match/u, JSON.stringify(drift));
  }
});

test("the acceptance store mask may be the directory that covers the store", () => {
  // Grok 1.0.34 cannot materialize a deny target under a directory the worker cannot search, so a
  // deployment that secures `<instance-root>/state` to `2000:2000 0700` declares that directory here.
  const store = "/var/lib/spawnfile/instance/state/wake-acceptance";
  const state = "/var/lib/spawnfile/instance/state";
  const lifted = resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, acceptanceStorePath: state });
  assert.equal(lifted.denyPaths.includes(state), true);
  assert.equal(lifted.denyPaths.includes(store), false);
  // The store itself still works where its parent is traversable, and produces a different digest —
  // a recomputation that disagrees with the deployment fails closed rather than certifying the slot.
  const leaf = resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, acceptanceStorePath: store });
  assert.equal(leaf.denyPaths.includes(store), true);
  assert.notEqual(grokBrokerProjectionSha256(leaf), grokBrokerProjectionSha256(lifted));
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, acceptanceStorePath: "/var" }),
    /base profile grant/u);
});

const skills = [{ name: "editor", files: [{ path: "SKILL.md", content: "---\nname: editor\ndescription: Edits.\n---\n\nEdit.\n" }] }];

test("no declared skills leaves the projection and its digest byte-identical", () => {
  const before = resolveOrganizationGrokBrokerProjection(config, "foreman", options);
  for (const none of [{ ...options, skills: [] }, { ...options, skills: undefined }]) {
    const projection = resolveOrganizationGrokBrokerProjection(config, "foreman", none);
    assert.equal(Object.hasOwn(projection, "skillsSha256"), false);
    assert.equal(grokBrokerProjectionSha256(projection), grokBrokerProjectionSha256(before));
    assert.equal(Object.hasOwn(grokBrokerServiceRegistrationFor(projection), "skillsSha256"), false);
  }
});

test("declared skills bind their digest into the projection and the registration it implies", () => {
  const plain = resolveOrganizationGrokBrokerProjection(config, "foreman", options);
  const projection = resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, skills });
  assert.equal(projection.skillsSha256, grokWorkerSkillsSha256(skills));
  assert.notEqual(grokBrokerProjectionSha256(projection), grokBrokerProjectionSha256(plain));
  // Mutation check: one changed byte of one skill changes the digest a preflight receipt binds.
  const edited = [{ ...skills[0]!, files: [{ path: "SKILL.md", content: skills[0]!.files[0]!.content.replace("Edit.", "Edit!") }] }];
  assert.notEqual(grokBrokerProjectionSha256(resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, skills: edited })), grokBrokerProjectionSha256(projection));
  const parse = (registration: Record<string, unknown>) => parseEngineBrokerServiceConfig({ version: "noopolis.daimon.engine-broker-service.v2", credentialHome: "/c", turnStore: "/t", registrations: [registration] }).registrations[0]!;
  const registration = grokBrokerServiceRegistrationFor(projection);
  assert.equal(registration.skillsSha256, projection.skillsSha256);
  verifyGrokBrokerRegistrationMatchesProjection(parse(registration), projection);
  const { skillsSha256: _dropped, ...withoutSkills } = registration;
  for (const drift of [withoutSkills, { ...registration, skillsSha256: grokWorkerSkillsSha256(edited) }]) {
    assert.throws(() => verifyGrokBrokerRegistrationMatchesProjection(parse(drift), projection), /does not match/u);
  }
  assert.throws(() => verifyGrokBrokerRegistrationMatchesProjection(parse(registration), plain), /does not match/u);
  assert.throws(() => resolveOrganizationGrokBrokerProjection(config, "foreman", { ...options, skills: [{ name: "../escape", files: skills[0]!.files }] }), /invalid agent skills/u);
});
