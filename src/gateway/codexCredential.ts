/** The Codex CLI's own `auth.json` schema, read and written by the gateway. */
export type CodexTokens = Readonly<{
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string | undefined;
}>;

const ACCOUNT_CLAIM = "https://api.openai.com/auth";

export function parseCodexAuth(bytes: Uint8Array): CodexTokens {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  const tokens = record(record(value)?.tokens);
  const accessToken = text(tokens?.access_token);
  const refreshToken = text(tokens?.refresh_token);
  if (accessToken === undefined || refreshToken === undefined) throw new Error("Codex realm credential is not a refreshable ChatGPT login");
  const idToken = text(tokens?.id_token) ?? "";
  return { idToken, accessToken, refreshToken, accountId: text(tokens?.account_id) ?? accountIdFromIdToken(idToken) };
}

/** Renders the exact shape `codex login` writes, so the realm stays a valid CLI login. */
export function renderCodexAuth(tokens: CodexTokens, now: Date = new Date()): Buffer {
  return Buffer.from(`${JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: tokens.accountId ?? null
    },
    last_refresh: now.toISOString()
  }, null, 2)}\n`);
}

/** Expiry in epoch milliseconds from a JWT `exp` claim; undefined when absent or opaque. */
export function jwtExpiryMs(token: string): number | undefined {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

export function accountIdFromIdToken(idToken: string): string | undefined {
  return text(record(jwtClaims(idToken)?.[ACCOUNT_CLAIM])?.chatgpt_account_id);
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try { return record(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))); } catch { return undefined; }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value : undefined;
