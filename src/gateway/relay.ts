import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

/** Limits follow OpenClaw's Codex inference proxy: 32 MiB bodies, bounded error bodies. */
export const GATEWAY_LIMITS = Object.freeze({
  requestBytes: 32 * 1024 * 1024,
  responseBytes: 256 * 1024 * 1024,
  errorBodyBytes: 8 * 1024,
  requestReadMs: 30_000,
  headersTimeoutMs: 10_000,
  upstreamHeadersMs: 120_000,
  streamIdleMs: 300_000,
  maxConcurrentRequests: 64
});

const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
/** Agent-side identity and routing never reaches upstream; the gateway sets its own. */
const REQUEST_DROPPED = new Set([...HOP_HEADERS, "host", "authorization", "content-length", "cookie", "chatgpt-account-id", "openai-organization", "openai-project", "forwarded", "x-real-ip", "expect"]);
/** fetch decodes content encodings, so stale encoding/length headers never go back. */
const RESPONSE_DROPPED = new Set([...HOP_HEADERS, "content-encoding", "content-length", "set-cookie", "alt-svc", "strict-transport-security"]);

export function upstreamRequestHeaders(input: IncomingHttpHeaders): Record<string, string> {
  return filterHeaders(input, REQUEST_DROPPED, (name) => name.startsWith("x-forwarded-"));
}

export function relayResponseHeaders(input: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  input.forEach((value, name) => { if (!RESPONSE_DROPPED.has(name.toLowerCase())) output[name.toLowerCase()] = value; });
  return output;
}

function filterHeaders(input: IncomingHttpHeaders, dropped: ReadonlySet<string>, droppedPrefix: (name: string) => boolean): Record<string, string> {
  const excluded = new Set(dropped);
  for (const token of String(input.connection ?? "").split(",")) excluded.add(token.trim().toLowerCase());
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (value === undefined || excluded.has(key) || droppedPrefix(key)) continue;
    output[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return output;
}

export class RequestTooLarge extends Error {}

export async function readRequestBody(request: IncomingMessage, limit = GATEWAY_LIMITS.requestBytes): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new RequestTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += value.length;
    if (size > limit) throw new RequestTooLarge();
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readBoundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
      size += next.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

export type ResponseUsage = Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>;

/** Watches an SSE relay for `response.completed` usage; bounded per line, never retains content. */
export function createUsageTap(onUsage: (usage: ResponseUsage) => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let line = "";
  const maxLine = 4 * 1024 * 1024;
  return (chunk) => {
    line += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = line.indexOf("\n")) !== -1) {
      const current = line.slice(0, index);
      line = line.slice(index + 1);
      if (current.startsWith("data:") && current.includes("\"response.completed\"")) {
        const usage = parseCompletedUsage(current.slice(5));
        if (usage !== undefined) onUsage(usage);
      }
    }
    if (line.length > maxLine) line = "";
  };
}

function parseCompletedUsage(data: string): ResponseUsage | undefined {
  try {
    const event = JSON.parse(data) as { type?: unknown; response?: { usage?: Record<string, unknown> } };
    const usage = event.type === "response.completed" ? event.response?.usage : undefined;
    const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return usage === undefined ? undefined : { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), totalTokens: count(usage.total_tokens) };
  } catch {
    return undefined;
  }
}
