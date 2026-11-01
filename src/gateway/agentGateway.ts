export const DAIMON_GATEWAY_URL_ENV = "DAIMON_GATEWAY_URL";
/**
 * Must keep its `_KEY` suffix: Codex's default shell environment excludes
 * every `*KEY*` name, so the agent key reaches Codex's provider but never a
 * model-run command.
 */
export const DAIMON_GATEWAY_KEY_ENV = "DAIMON_GATEWAY_KEY";

/** What an agent-side caller holds: the gateway URL and its own key, never a subscription token. */
export type AgentGateway = Readonly<{ url: string; key: string }>;

/** Both variables or neither; half a gateway is a deployment fault, never a silent fallback. */
export function gatewayFromEnvironment(environment: NodeJS.ProcessEnv = process.env): AgentGateway | undefined {
  const rawUrl = environment[DAIMON_GATEWAY_URL_ENV];
  const key = environment[DAIMON_GATEWAY_KEY_ENV];
  if ((rawUrl === undefined || rawUrl === "") && (key === undefined || key === "")) return undefined;
  if (!rawUrl || !key) throw new Error(`${DAIMON_GATEWAY_URL_ENV} and ${DAIMON_GATEWAY_KEY_ENV} must be set together`);
  if (!/^[A-Za-z0-9._~+/=-]{16,512}$/u.test(key)) throw new Error(`${DAIMON_GATEWAY_KEY_ENV} is not a gateway key`);
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error(`${DAIMON_GATEWAY_URL_ENV} must be a URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${DAIMON_GATEWAY_URL_ENV} must be a plain http(s) URL`);
  return { url: url.href.replace(/\/+$/u, ""), key };
}
