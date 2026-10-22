/**
 * Codex's own `model_reasoning_effort` values (`codex-rs/protocol/src/openai_models.rs`,
 * `ReasoningEffort::as_str`), verified against the installed `codex` CLI
 * (0.153.4): `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`,
 * `ultra`, `persistent`. Codex's own parser also accepts an arbitrary
 * `Custom(String)` fallback for forward compatibility with models the
 * installed CLI does not yet know about; Daimon's schema deliberately does
 * not extend that far; an unrecognized value is rejected as a likely
 * misconfiguration rather than silently forwarded to the model.
 */
export const ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"] as const;
export const ORGANIZATION_RUNTIME_CODEX_WORKSPACE_NO_NETWORK_POLICY = { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } as const;

