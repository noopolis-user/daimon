import { ENGINE_DESCRIPTORS } from "../descriptors.js";
import { codexTaskClockArgs } from "./piTaskClock.js";
import { codexFilesystemRules } from "./codexFilesystemRules.js";
import type { CliEngineOptions } from "../../pi/cliSession.js";

/**
 * Codex's `--json` stream is unconditional: it is the only output shape that
 * carries `turn.completed.usage`, and an unmetered Codex turn is one whose
 * subscription cost is invisible. The guarded arguments make this Daimon's
 * security and metering boundary rather than a caller-controlled format.
 *
 * `model`/`reasoningEffort` come from parsed, bounded organization-runtime
 * config, but are rendered defensively anyway: each is emitted as a single
 * `--flag=value` argv token (never a bare flag followed by a separate value
 * token), so a value that itself looks like a flag (e.g. `--sandbox`) can
 * never be parsed as a second, independent argument — the same shape already
 * used below for `mcp_servers.daimon.url=`. Omitting both fields leaves Codex's
 * model defaults unchanged.
 *
 * The per-wake MCP server is always enabled and required. Otherwise Codex can
 * continue a normal turn with only built-in tools after MCP startup fails.
 * Subscription apps and installed plugins are not caller-declared tools.
 * Disable their discovery per invocation, including with strict config: the
 * CLI's defaults can otherwise add them even when user config is ignored.
 */
export const renderCodexArgs = (
  options: Pick<CliEngineOptions, "commandArgs" | "model" | "reasoningEffort" | "codexSandbox" | "codexSandboxProtectedPaths" | "codexSandboxReadablePaths" | "codexProjectDocMaxBytes">,
  cwd: string,
  endpoint: string | undefined,
  sandbox: string = options.codexSandbox?.mode ?? process.env.DAIMON_CODEX_SANDBOX ?? "danger-full-access"
): string[] => {
  const strictPolicy = options.codexSandbox;
  if (options.codexProjectDocMaxBytes !== undefined && (options.codexProjectDocMaxBytes !== 0 || strictPolicy === undefined)) {
    throw new Error("Disabling Codex ambient instructions requires the strict policy and an exact zero byte limit");
  }
  if (strictPolicy !== undefined && (strictPolicy.mode !== ENGINE_DESCRIPTORS.codex.sandbox.policy.mode || strictPolicy.networkAccess !== ENGINE_DESCRIPTORS.codex.sandbox.policy.networkAccess || strictPolicy.webSearch !== ENGINE_DESCRIPTORS.codex.sandbox.policy.webSearch || Object.keys(strictPolicy).length !== 3)) {
    throw new Error("Codex sandbox policy is Daimon-owned and must be workspace-write with network and web search disabled");
  }
  const effectiveSandbox = strictPolicy?.mode ?? sandbox;
  const profileName = "daimon-strict";
  const policyArgs = strictPolicy === undefined ? [] : [
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    ...(options.codexProjectDocMaxBytes === 0 ? ["-c", "project_doc_max_bytes=0"] : []),
    "-c", "web_search=\"disabled\"",
    "-c", `default_permissions=${JSON.stringify(profileName)}`,
    "-c", renderCodexPermissionProfile(profileName, options.codexSandboxProtectedPaths ?? [], options.codexSandboxReadablePaths ?? [], cwd),
    "-c", "approval_policy=\"never\"",
    "-c", `mcp_servers={daimon={url=\"${endpoint}\",enabled=true,default_tools_approval_mode=\"approve\"}}`
  ];
  return [...assertSafeCodexCommandArgs(options.commandArgs, strictPolicy !== undefined), "exec", ...(strictPolicy === undefined ? ["--sandbox", effectiveSandbox] : []), ...policyArgs, "--skip-git-repo-check",
  ...(options.model === undefined ? [] : [`--model=${options.model}`]),
  ...(options.reasoningEffort === undefined ? [] : ["-c", `model_reasoning_effort=${options.reasoningEffort}`]),
  "--color", "never", "--json", "-C", cwd,
  "-c", `mcp_servers.daimon.url=${endpoint}`,
  "-c", "features.apps=false", "-c", "features.plugins=false",
  "-c", "mcp_servers.daimon.enabled=true",
  "-c", "mcp_servers.daimon.required=true", ...codexTaskClockArgs(), "-"];
};

export const renderCodexPermissionProfile = (
  profileName: string,
  protectedPaths: readonly string[],
  readablePaths: readonly string[] = [],
  workspacePath?: string
): string => {
  const filesystem: Record<string, "read" | "write" | "deny" | Record<string, "write">> = {
    ":workspace_roots": { ".": "write" },
    ...codexFilesystemRules(protectedPaths, readablePaths, workspacePath)
  };
  return `permissions=${tomlInline({ [profileName]: {
    extends: ":workspace",
    filesystem,
    network: { enabled: false }
  } })}`;
};

/** Caller arguments cannot reopen Codex's sandbox, output, cwd, or config boundary. */
const assertSafeCodexCommandArgs = (args: readonly string[] | undefined, strictPolicy = false): readonly string[] => {
  const values = args ?? [];
  const pattern = /^(?:--json|--sandbox|--dangerously-bypass-approvals-and-sandbox|--output-last-message|--config|--ignore-user-config|--ignore-rules|--skip-git-repo-check|--color|--cd|--enable|-c|-C)(?:=|$)/u;
  const strictPattern = /^(?:--strict-config|--profile|-p|-P|--permissions-profile|--enable|--disable|--add-dir|--search)(?:=|$)|^(?:default_permissions|permissions)(?:=|\.)/u;
  if (values.some((value) => pattern.test(value) || (strictPolicy && strictPattern.test(value)))) {
    throw new Error("Codex security-boundary arguments are Daimon-owned");
  }
  return values;
};

function tomlInline(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${JSON.stringify(key)}=${tomlInline(entry)}`).join(",")}}`;
  }
  throw new Error("unsupported Codex permission profile value");
}
