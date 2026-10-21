/**
 * A content-free description of one refused worker body, for the broker's own
 * stderr: byte length, top-level member names, offered tool names, message
 * count and roles, and `tool_choice`. Never a message, a parameter schema, a
 * value of any other member, a header or a token.
 *
 * Every name comes from a body the worker wrote, so each is admitted only as a
 * plain short identifier (anything else is `<invalid>`) and every list is
 * bounded with a `<truncated>` last entry. A body that is not a JSON object
 * reports its byte length alone.
 */
export type GrokBrokerProxyBodyShape = Readonly<{
  bytes: number;
  keys?: readonly string[];
  tools?: readonly string[] | "absent" | "invalid";
  messages?: number | "invalid";
  roles?: readonly string[];
  tool_choice?: string;
}>;

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
export const GROK_PROXY_BODY_SHAPE_LIST_MAX = 32;

const safeName = (value: unknown): string => typeof value === "string" && NAME.test(value) ? value : "<invalid>";
const bounded = (values: readonly string[]): readonly string[] =>
  values.length <= GROK_PROXY_BODY_SHAPE_LIST_MAX ? values : [...values.slice(0, GROK_PROXY_BODY_SHAPE_LIST_MAX - 1), "<truncated>"];
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Roles in order, with consecutive repeats collapsed to `role*n` so a long history stays short. */
const roleRuns = (messages: readonly unknown[]): readonly string[] => {
  const runs: string[] = [];
  let last: string | undefined; let count = 0;
  const flush = () => { if (last !== undefined) runs.push(count > 1 ? `${last}*${count}` : last); };
  for (const message of messages) {
    const role = isObject(message) ? safeName(message.role) : "<invalid>";
    if (role === last) { count++; continue; }
    flush(); last = role; count = 1;
  }
  flush();
  return bounded(runs);
};

export function grokBrokerProxyBodyShape(body: Uint8Array): GrokBrokerProxyBodyShape {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(body)); } catch { return { bytes: body.byteLength }; }
  if (!isObject(parsed)) return { bytes: body.byteLength };
  const tools = parsed.tools === undefined ? "absent" as const : Array.isArray(parsed.tools)
    ? bounded(parsed.tools.map((tool) => isObject(tool) && isObject(tool.function) ? safeName(tool.function.name) : "<invalid>"))
    : "invalid" as const;
  const choice = parsed.tool_choice;
  return {
    bytes: body.byteLength,
    keys: bounded(Object.keys(parsed).map(safeName).sort()),
    tools,
    messages: Array.isArray(parsed.messages) ? parsed.messages.length : "invalid",
    ...(Array.isArray(parsed.messages) ? { roles: roleRuns(parsed.messages) } : {}),
    ...(choice === undefined ? {} : {
      tool_choice: typeof choice === "string" ? safeName(choice)
        : isObject(choice) ? `object:${isObject(choice.function) ? safeName(choice.function.name) : safeName(choice.type)}` : "<invalid>"
    })
  };
}

/** One line, `key=value` pairs, for the `[grok-proxy] refused:` log. */
export const formatGrokBrokerProxyBodyShape = (shape: GrokBrokerProxyBodyShape): string => [
  `bytes=${shape.bytes}`,
  ...(shape.keys === undefined ? [] : [`keys=${shape.keys.join(",")}`]),
  ...(shape.tools === undefined ? [] : [`tools=${Array.isArray(shape.tools) ? shape.tools.join(",") : shape.tools}`]),
  ...(shape.messages === undefined ? [] : [`messages=${shape.messages}`]),
  ...(shape.roles === undefined ? [] : [`roles=${shape.roles.join(",")}`]),
  ...(shape.tool_choice === undefined ? [] : [`tool_choice=${shape.tool_choice}`])
].join(" ");
