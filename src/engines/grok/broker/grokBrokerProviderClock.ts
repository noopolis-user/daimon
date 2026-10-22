import { parseBrokerProcessClock } from "./grokBrokerTaskClock.js";
import { parseGrokBrokerProxyJson } from "./grokBrokerProxyJson.js";

export type GrokBrokerProviderClockObservation = Readonly<{
  requests: number;
  linesRewritten: number;
  requestsWithoutDateLine: number;
  /** Date-like message lines outside the injected block; absent on older seals. */
  linesIgnored?: number;
  /** The last rewritten line's dates; null until a line is rewritten. */
  injectedDate: string | null;
  taskDate: string | null;
}>;

export class GrokBrokerProviderClockRefusal extends Error {
  constructor(readonly reason: "task_clock_date_format" | "task_clock_date_range" | "request_body_rejected") {
    super(`grok broker proxy refused: ${reason}`);
  }
}

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const DATE_LINE = /^Today's date: ([0-9]{4}-[0-9]{2}-[0-9]{2})$/u;
const DATE_LIKE = /today['’]?s\s+date\b/iu;
const MAX_TASK_MS = 253_402_300_799_999;

/** One processClock, owned by one turn; never reads the broker's ambient TZ. */
export class GrokBrokerProviderClock {
  private readonly offsetMs: number;
  private observation: GrokBrokerProviderClockObservation = {
    requests: 0, linesRewritten: 0, requestsWithoutDateLine: 0, linesIgnored: 0,
    injectedDate: null, taskDate: null
  };

  constructor(processClock: string, private readonly now: () => number = () => Date.now()) {
    this.offsetMs = Math.round(Number(parseBrokerProcessClock(processClock)) * 1000);
  }

  rewrite(body: Uint8Array): Uint8Array {
    this.observation = { ...this.observation, requests: this.observation.requests + 1 };
    let parsed: ReturnType<typeof parseGrokBrokerProxyJson>;
    try { parsed = parseGrokBrokerProxyJson(body); }
    catch { throw new GrokBrokerProviderClockRefusal("request_body_rejected"); }
    const taskMs = this.now() + this.offsetMs;
    if (!Number.isSafeInteger(taskMs) || taskMs < 0 || taskMs > MAX_TASK_MS) {
      throw new GrokBrokerProviderClockRefusal("task_clock_date_range");
    }
    // The native launcher pins TZ=UTC. Compute once per request, including
    // history resends; a long turn may cross midnight between requests.
    const taskDate = new Date(taskMs).toISOString().slice(0, 10);
    let lines = 0;
    let ignored = 0;
    let injectedDate: string | null = null;
    const countIgnored = (text: string) => text.split(/\r\n|\r|\n/u).filter((line) => DATE_LIKE.test(line)).length;
    const rewriteText = (text: string, injected: boolean): string => {
      const block = injected ? /<user_info>([\s\S]*?)<\/user_info>/u.exec(text) : null;
      if (block === null) {
        ignored += countIgnored(text);
        return text;
      }
      const before = text.slice(0, block.index), after = text.slice(block.index + block[0].length);
      ignored += countIgnored(before) + countIgnored(after);
      const rewritten = block[1]!.split(/(\r\n|\r|\n)/u).map((line) => {
        if (!DATE_LIKE.test(line)) return line;
        const match = DATE_LINE.exec(line);
        if (match === null) throw new GrokBrokerProviderClockRefusal("task_clock_date_format");
        lines++;
        injectedDate = match[1]!;
        return `Today's date: ${taskDate}`;
      }).join("");
      return `${before}<user_info>${rewritten}</user_info>${after}`;
    };
    if (Array.isArray(parsed.value.messages)) {
      let firstUser = true;
      for (const message of parsed.value.messages) {
        if (!isRecord(message)) continue;
        const injected = message.role === "user" && firstUser;
        if (message.role === "user") firstUser = false;
        if (typeof message.content === "string") {
          message.content = rewriteText(message.content, injected);
        } else if (Array.isArray(message.content)) {
          const parts = message.content.filter((part): part is Record<string, unknown> & { text: string } =>
            isRecord(part) && part.type === "text" && typeof part.text === "string"
          );
          // A block or date can straddle text parts. Replacements have exactly
          // the same width, so slicing restores every original part boundary.
          const rewritten = rewriteText(parts.map((part) => part.text).join(""), injected);
          let start = 0;
          for (const part of parts) {
            const end = start + part.text.length;
            part.text = rewritten.slice(start, end);
            start = end;
          }
        }
      }
    }
    // Commit only after the entire body passes: a refused request rewrites no
    // lines upstream, even when an earlier line had the recognized format.
    this.observation = {
      requests: this.observation.requests,
      linesRewritten: this.observation.linesRewritten + lines,
      requestsWithoutDateLine: this.observation.requestsWithoutDateLine + (lines === 0 ? 1 : 0),
      linesIgnored: (this.observation.linesIgnored ?? 0) + ignored,
      injectedDate: lines === 0 ? this.observation.injectedDate : injectedDate,
      taskDate: lines === 0 ? this.observation.taskDate : taskDate
    };
    return lines === 0 ? parsed.body : Buffer.from(JSON.stringify(parsed.value));
  }

  snapshot(): GrokBrokerProviderClockObservation {
    return { ...this.observation };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Closed, dates-only observation on the v3 terminal frame and durable seal. */
export function parseGrokBrokerProviderClockObservation(value: unknown): GrokBrokerProviderClockObservation {
  if (!isRecord(value)) throw new TypeError("invalid broker frame");
  const fields = ["requests", "linesRewritten", "requestsWithoutDateLine", "injectedDate", "taskDate"];
  if (Object.keys(value).some((key) => !fields.includes(key) && key !== "linesIgnored") ||
      fields.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("invalid broker frame");
  }
  for (const key of [...fields.slice(0, 3), ...(Object.hasOwn(value, "linesIgnored") ? ["linesIgnored"] : [])]) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
      throw new TypeError("invalid broker frame");
    }
  }
  const result = value as unknown as GrokBrokerProviderClockObservation;
  if (result.requestsWithoutDateLine > result.requests ||
      (result.linesRewritten > 0 && result.requestsWithoutDateLine === result.requests)) {
    throw new TypeError("invalid broker frame");
  }
  for (const date of [result.injectedDate, result.taskDate]) {
    if (result.linesRewritten === 0 ? date !== null : typeof date !== "string" || !DATE.test(date)) {
      throw new TypeError("invalid broker frame");
    }
  }
  return { ...result };
}
