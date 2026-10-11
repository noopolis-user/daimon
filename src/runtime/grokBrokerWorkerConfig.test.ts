import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { GROK_BROKER_TASK_CLOCK } from "../contracts/grokBrokerTaskClock.js";
import { shellEnvironmentPolicyEntries } from "../contracts/shellEnvironmentPolicy.js";
import { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS } from "./grokBrokerModelPolicy.js";
import { GROK_1_0_34_BUNDLED_SKILLS, grokBrokerWorkerConfigSha256, renderGrokBrokerWorkerArgs, renderGrokBrokerWorkerConfig, renderGrokBrokerWorkerConfigWith } from "./grokBrokerWorkerConfig.js";

const section = (config: string, header: string): string => {
  const start = config.indexOf(`${header}\n`);
  assert.notEqual(start, -1, `missing ${header}`);
  const end = config.indexOf("\n[", start + header.length);
  return config.slice(start, end === -1 ? undefined : end);
};

test("worker config uses only the launcher-set turn capability, the fixed loopback proxy, and the capability-scoped MCP facade", () => {
  const config = renderGrokBrokerWorkerConfig();
  assert.match(section(config, "[model.daimon-broker-grok]"), /base_url = "http:\/\/127\.0\.0\.1:43123\/v1"\nenv_key = "DAIMON_PROVIDER_CAPABILITY"\n/u);
  // Grok 1.0.34 ignores [auth_provider.*] for custom models; a helper table would silently send no bearer.
  assert.doesNotMatch(config, /auth_provider/u);
  assert.equal(section(config, "[mcp_servers.daimon]"), '[mcp_servers.daimon]\nurl = "http://127.0.0.1:43124/mcp"\nbearer_token_env_var = "DAIMON_MCP_CAPABILITY"\n');
  assert.doesNotMatch(config, /access_token|refresh_token|auth\.json/u);
});

test("worker config disables every bundled 1.0.34 skill, workflows, and the per-turn session title request", () => {
  const config = renderGrokBrokerWorkerConfig();
  assert.equal(GROK_1_0_34_BUNDLED_SKILLS.length, 25);
  assert.equal(section(config, "[skills]"), `[skills]\ndisabled = [${GROK_1_0_34_BUNDLED_SKILLS.map((name) => JSON.stringify(name)).join(", ")}]\n`);
  assert.equal(section(config, "[workflows]"), "[workflows]\nenabled = false\n");
  assert.match(section(config, "[models]"), /\nsession_summary = "daimon-session-title-disabled"\n/u);
  assert.equal(section(config, "[model.daimon-session-title-disabled]"), '[model.daimon-session-title-disabled]\nmodel = "disabled"\nbase_url = "http://127.0.0.1:43123/v1"\napi_key = "session-title-disabled"\nmax_retries = 0\nhidden = true\n');
  // The sink carries a static placeholder key only: no env_key, so it can never pick up the turn capability.
  assert.doesNotMatch(section(config, "[model.daimon-session-title-disabled]"), /env_key|DAIMON_/u);
  for (const toggle of ["title_refresh", "telemetry", "session_recap", "turn_summary", "backend_tools", "ask_user_question"]) assert.match(section(config, "[features]"), new RegExp(`\\n${toggle} = false\\n`, "u"));
  assert.match(section(config, "[cli]"), /auto_update = false\nuse_leader = false/u);
});

test("every model the worker can reach fails fast rather than retrying a refusal blindly", () => {
  // Grok 1.0.34's default retries a refused request with backoff past 45 s.
  // The sink and the evaluator client always pinned this; the worker's own
  // model — the one path that spends money — did not, so a refusal there could
  // stall a turn for minutes after its work was done with nothing logged.
  for (const model of GROK_BROKER_MODELS) {
    for (const reasoningEffort of GROK_BROKER_REASONING_EFFORTS) {
      const config = renderGrokBrokerWorkerConfig({ model, reasoningEffort });
      for (const block of ["[model.daimon-broker-grok]", "[model.daimon-session-title-disabled]"]) {
        assert.match(section(config, block), /\nmax_retries = 0\n/u, `${block} ${model}/${reasoningEffort}`);
      }
    }
  }
});

test("the declared model and effort reach the worker's only model as its sole allowed effort", () => {
  const config = renderGrokBrokerWorkerConfig({ model: "grok-build", reasoningEffort: "medium" });
  assert.match(section(config, "[model.daimon-broker-grok]"), /\nmodel = "grok-build"\n/u);
  assert.match(section(config, "[models]"), /\ndefault = "daimon-broker-grok"\ndefault_reasoning_effort = "medium"\n/u);
  assert.equal(section(config, "[[model.daimon-broker-grok.reasoning_efforts]]"), '[[model.daimon-broker-grok.reasoning_efforts]]\nvalue = "medium"\nlabel = "Medium"\ndefault = true\n');
  assert.equal(config.match(/reasoning_efforts\]\]/gu)?.length, 1);
  assert.match(renderGrokBrokerWorkerConfig(), /\nmodel = "grok-4\.6"\n[\s\S]*value = "low"/u);
  for (const invalid of [{ model: "grok-3" }, { reasoningEffort: "xhigh" }, { model: "grok-4.6", reasoningEffort: "low", extra: true }]) {
    assert.throws(() => renderGrokBrokerWorkerConfig(invalid as never), /model policy/u);
  }
});

test("the manifest pins the sha256 of every renderable worker config", () => {
  for (const model of GROK_BROKER_MODELS) {
    for (const reasoningEffort of GROK_BROKER_REASONING_EFFORTS) {
      const digest = createHash("sha256").update(renderGrokBrokerWorkerConfig({ model, reasoningEffort })).digest("hex");
      assert.equal(grokBrokerWorkerConfigSha256({ model, reasoningEffort }), digest);
      assert.equal(GROK_ENGINE_BROKER.worker.configSha256[model][reasoningEffort], digest, `${model}/${reasoningEffort}`);
      const clocked = grokBrokerWorkerConfigSha256({ model, reasoningEffort }, "clocked");
      assert.equal(GROK_ENGINE_BROKER.worker.clockedConfigSha256[model][reasoningEffort], clocked);
    }
  }
});

test("clocked config appends exactly four tool environment keys, with the direct policy filters and no offset", () => {
  const base = renderGrokBrokerWorkerConfig();
  const clocked = renderGrokBrokerWorkerConfig({}, "clocked");
  const env = { LD_PRELOAD: GROK_BROKER_TASK_CLOCK.preloadPath, FAKETIME_TIMESTAMP_FILE: GROK_BROKER_TASK_CLOCK.timestampFilePath, FAKETIME_DONT_FAKE_MONOTONIC: "1", LC_ALL: "C" };
  assert.equal(clocked, `${base}\n[shell_environment_policy]\n${shellEnvironmentPolicyEntries(env).join("\n")}\n`);
  assert.deepEqual(clocked.match(/"[A-Z_]+"=/gu), ['"LD_PRELOAD"=', '"FAKETIME_TIMESTAMP_FILE"=', '"FAKETIME_DONT_FAKE_MONOTONIC"=', '"LC_ALL"=']);
  assert.doesNotMatch(clocked, /"FAKETIME"=|NOOPOLIS_TASK_CLOCK|MNEME_CLOCK/u);
  assert.doesNotMatch(base, /shell_environment_policy|FAKETIME/u);
  assert.match(clocked, /inherit="all"\nignore_default_excludes=false\nexclude=\[\]\ninclude_only=\[\]/u);
});

test("the probe-only renderer refuses non-loopback or injected endpoints", () => {
  const policy = { model: "grok-4.6", reasoningEffort: "low" } as const;
  assert.throws(() => renderGrokBrokerWorkerConfigWith(policy, { proxyPort: 0, mcpUrl: "http://127.0.0.1:1/mcp" }), /invalid/u);
  assert.throws(() => renderGrokBrokerWorkerConfigWith(policy, { proxyPort: 1, mcpUrl: "http://example.com/mcp" }), /invalid/u);
  assert.throws(() => renderGrokBrokerWorkerConfigWith(policy, { proxyPort: 1, mcpUrl: "http://127.0.0.1:1/mcp\"\n[evil]" }), /invalid/u);
  const args = renderGrokBrokerWorkerArgs("/run/worker/prompt", "/workspace");
  assert.equal(args.includes("--prompt-file"), true); assert.equal(args.includes("--single"), false);
});

// Frozen from origin/main 796b414: a pin update must never silently change production bytes.
test("unclocked bytes retain every origin/main digest", () => {
  assert.deepEqual(GROK_BROKER_MODELS.flatMap((model) => GROK_BROKER_REASONING_EFFORTS.map((reasoningEffort) => grokBrokerWorkerConfigSha256({ model, reasoningEffort }))), ["ab58499ac32678097c146479896f2b8a8e2b0e39aea22dc0a60b6227e370538e", "df1a5cc84346e7f6bf6090492fbd19faaefb42953e3bb2e8c6cbc0572242403f", "65b0212564fb74042b1503d293fb8d3620276033264c0efade2a539ca09218e3", "8247127c3625ff7c5d8d527a53596b89ec6557a821ac46cfd00bd122b90daff6", "59288cee61297bb8c002097061a48f77b09d310754187a253ee089f7172a9155", "c63c3387ce92d94ec3f690abfe98942afcd7c9e17ff84816bbe751f340ab251f", "fb343f2809903f26d21681470943235031f946e99085542fd89555eb7782cbb5", "8a587ef75c90eab70d19b24583e60051d6fba9d90c558839fdbb15588b4cc656", "a23724e00d670caee185ba7690d2daa868173e53905cf446f5329666f01ab4e3"]);
});
