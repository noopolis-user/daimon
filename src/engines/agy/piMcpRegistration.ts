import { DAIMON_MCP_SERVER_NAME } from "../../pi/cliMcpRegistration.js";

/**
 * `agy mcp add --type http <name> <url>`.
 *
 * AGY has no per-invocation MCP flag, so this writes into the config file AGY
 * reads at `$HOME/.gemini/config/mcp_config.json`. That is safe to do per wake
 * because Daimon already gives every AGY agent its own `HOME`
 * (`runtimeHomePath`, see `cliChildEnvironment`): two agents in one
 * organization cannot collide, and a developer's real `~/.gemini` is never on
 * the path a runtime child sees. `add` is an upsert, so a stale entry left by a
 * crashed wake is replaced rather than duplicated.
 *
 * No `--header` is passed: Daimon's tool endpoint is an unauthenticated
 * loopback listener on an ephemeral port, exactly as Codex and Grok receive it.
 * Adding a bearer header here would put a secret in `argv` and in a file on the
 * agent's durable runtime home for no gain.
 */
export const renderAgyMcpAddArgs = (commandArgs: readonly string[] | undefined, endpoint: string): string[] =>
  [...(commandArgs ?? []), "mcp", "add", "--type", "http", DAIMON_MCP_SERVER_NAME, endpoint];

export const renderAgyMcpRemoveArgs = (commandArgs: readonly string[] | undefined): string[] =>
  [...(commandArgs ?? []), "mcp", "remove", DAIMON_MCP_SERVER_NAME];
