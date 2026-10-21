import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { GROK_WORKER_VISIBLE_TOOLS } from "../contracts/grokWorkerContract.js";
import type { EngineBrokerCapabilities } from "./engineBrokerCapabilities.js";
import { DEFAULT_GROK_BROKER_MODEL_POLICY, parseGrokBrokerModelPolicy, type GrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";

const MAX_BODY = 2 * 1024 * 1024;

/**
 * Which body-gate check refused a request: a closed, content-free code, so a
 * refusal on the broker's stderr names its cause without a stub harness.
 */
export type GrokBrokerProxyRejectionCheck = "route" | "body_size" | "bearer" | "scope" | "client_version" | "json" | "envelope" | "model" | "reasoning_effort" | "tools" | "members" | "stream_options";

/** A body-gate refusal. The message is the historic one; `check` names the failed check. */
export class GrokBrokerProxyRequestRejection extends Error {
  constructor(readonly check: GrokBrokerProxyRejectionCheck) { super("broker proxy request rejected"); }
}
function reject(check: GrokBrokerProxyRejectionCheck): never { throw new GrokBrokerProxyRequestRejection(check); }
export type GrokBrokerProxyInput = Readonly<{ method: string; pathname: string; headers: Readonly<Record<string, string | undefined>>; body: Uint8Array; agentId?: string; turnId?: string }>;
export type GrokBrokerUpstreamRequest = Readonly<{ url: "https://cli-chat-proxy.grok.com/v1/chat/completions"; headers: Readonly<Record<string, string>>; body: Uint8Array }>;

/**
 * Authorizes one worker request and rebuilds it for the provider.
 *
 * Everything that decides spend is checked here, before a bearer is attached
 * and before any upstream call:
 * - the client version is exactly the pinned Grok CLI (`GROK_ENGINE_BROKER.grokCliVersion`);
 * - the body model and `reasoning_effort` are exactly the declared policy, and
 *   the model override header follows that declaration instead of a constant;
 * - the offered tool names are exactly the lean visible set. Grok 1.0.34 turns
 *   an unmappable `--tools` entry into its full 19-tool set, and its per-turn
 *   `session_title` request carries a single forced tool; both are refused.
 */
export function authorizeGrokBrokerProxyRequest(input: GrokBrokerProxyInput, capabilities: EngineBrokerCapabilities, bearer: string, policy: GrokBrokerModelPolicy = DEFAULT_GROK_BROKER_MODEL_POLICY): GrokBrokerUpstreamRequest {
  const declared = parseGrokBrokerModelPolicy(policy);
  if (input.method !== "POST" || input.pathname !== "/v1/chat/completions") reject("route");
  if (input.body.byteLength < 2 || input.body.byteLength > MAX_BODY) reject("body_size");
  const authorization = input.headers.authorization; const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/u);
  if (match === null || match === undefined) return reject("bearer");
  const scope = capabilities.authorizeToken(match[1]!);
  if (scope === undefined || (input.agentId !== undefined && scope.agentId !== input.agentId) || (input.turnId !== undefined && scope.turnId !== input.turnId)) reject("scope");
  if (!bearer || /[\r\n]/u.test(bearer)) throw new Error("broker credential authority unavailable");
  const clientVersion = input.headers["x-grok-client-version"];
  if (clientVersion !== GROK_ENGINE_BROKER.grokCliVersion) reject("client_version");
  let parsed: Record<string, unknown>;
  // `__proto__` is refused at any depth: JSON.parse makes it an ordinary own
  // member, but an upstream JavaScript parser may treat it as a prototype.
  try {
    parsed = JSON.parse(Buffer.from(input.body).toString("utf8"), (key, value: unknown) => {
      if (key === "__proto__") throw new Error("broker proxy request rejected");
      return value;
    }) as Record<string, unknown>;
  } catch { return reject("json"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.stream !== true || !Array.isArray(parsed.messages)) reject("envelope");
  if (parsed.model !== declared.model) reject("model");
  if (parsed.reasoning_effort !== declared.reasoningEffort) reject("reasoning_effort");
  if (!exactLeanTools(parsed.tools)) reject("tools");
  if (Object.keys(parsed).some((key) => !LEAN_BODY_MEMBERS.has(key))) reject("members");
  if (!validStreamOptions(parsed.stream_options)) reject("stream_options");
  // Keep origin/main's production handling: UTF-8 replacement decoding, then
  // serialize the validated object (including last-member-wins duplicates).
  // Only a clocked turn takes the stricter date rewrite before this gate.
  return {
    url: "https://cli-chat-proxy.grok.com/v1/chat/completions",
    headers: {
      authorization: `Bearer ${bearer}`, "content-type": "application/json",
      "x-xai-token-auth": "xai-grok-cli", "x-grok-model-override": declared.model,
      "x-grok-client-version": clientVersion, "x-grok-client-identifier": "grok-shell"
    },
    body: Buffer.from(JSON.stringify(parsed))
  };
}

/** Top-level members of a Grok 1.0.34 lean worker chat-completions body (live stub capture). */
const LEAN_BODY_MEMBERS: ReadonlySet<string> = new Set(["messages", "model", "reasoning_effort", "stream", "stream_options", "tools"]);
/** Members of each lean tool `function` entry (live stub capture). */
const LEAN_FUNCTION_MEMBERS: ReadonlySet<string> = new Set(["description", "name", "parameters"]);
const validStreamOptions = (value: unknown): boolean => value === undefined
  || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => key === "include_usage") && typeof (value as { include_usage?: unknown }).include_usage === "boolean");

export function exactLeanTools(tools: unknown): boolean {
  if (!Array.isArray(tools) || tools.length !== GROK_WORKER_VISIBLE_TOOLS.length) return false;
  const names = tools.map((tool) => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool) || (tool as { type?: unknown }).type !== "function" || Object.keys(tool).some((key) => key !== "type" && key !== "function")) return undefined;
    const fn = (tool as { function?: unknown }).function;
    if (fn === null || typeof fn !== "object" || Array.isArray(fn) || Object.keys(fn).some((key) => !LEAN_FUNCTION_MEMBERS.has(key))) return undefined;
    return (fn as { name?: unknown }).name;
  });
  return JSON.stringify([...names].sort()) === JSON.stringify(GROK_WORKER_VISIBLE_TOOLS);
}
