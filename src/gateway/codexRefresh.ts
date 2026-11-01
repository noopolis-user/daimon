import { accountIdFromIdToken, type CodexTokens } from "./codexCredential.js";

export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** The Codex CLI's public OAuth client id; the realm login was minted for it. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_TIMEOUT_MS = 30_000;
const MAX_REFRESH_RESPONSE_BYTES = 64 * 1024;

/** A refusal by the token endpoint itself: the login is gone, not the network. */
export class CodexRefreshRejected extends Error {
  constructor() { super("Codex refresh token was rejected"); }
}

export type CodexRefresh = (current: CodexTokens) => Promise<CodexTokens>;

/** Refreshes exactly as the CLI does: JSON body, `refresh_token` grant, CLI client id and scope. */
export function createCodexRefresh(options: Readonly<{ tokenUrl?: string; fetch?: typeof fetch }> = {}): CodexRefresh {
  const fetcher = options.fetch ?? fetch;
  return async (current) => {
    let response: Response;
    try {
      response = await fetcher(options.tokenUrl ?? CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: current.refreshToken, scope: "openid profile email" }),
        redirect: "error",
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
      });
    } catch {
      throw new Error("Codex token endpoint is unreachable");
    }
    const bytes = await boundedBody(response);
    // Only a named refusal of this login fences the realm; 408, 429 and anything unnamed stay transient.
    if ((response.status === 400 || response.status === 401) && refusesLogin(bytes)) throw new CodexRefreshRejected();
    if (!response.ok) throw new Error(`Codex token endpoint answered ${response.status}`);
    let value: Record<string, unknown>;
    try { value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; } catch { throw new Error("Codex token endpoint answered invalid JSON"); }
    const accessToken = nonBlank(value.access_token);
    if (accessToken === undefined) throw new Error("Codex token endpoint answered without an access token");
    const idToken = nonBlank(value.id_token) ?? current.idToken;
    return {
      accessToken,
      idToken,
      refreshToken: nonBlank(value.refresh_token) ?? current.refreshToken,
      accountId: accountIdFromIdToken(idToken) ?? current.accountId
    };
  };
}

/** Error codes the token endpoint and the Codex CLI treat as a dead login. */
export const CODEX_REFRESH_REJECTION_CODES = Object.freeze(["invalid_grant", "refresh_token_reused", "refresh_token_invalidated", "refresh_token_expired", "token_revoked"] as const);

function refusesLogin(bytes: Buffer): boolean {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return false; }
  const body = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = body.error;
  const code = typeof error === "string" ? error
    : error !== null && typeof error === "object" && typeof (error as Record<string, unknown>).code === "string" ? (error as Record<string, unknown>).code
      : body.code;
  return (CODEX_REFRESH_REJECTION_CODES as readonly unknown[]).includes(code);
}

async function boundedBody(response: Response): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_REFRESH_RESPONSE_BYTES) throw new Error("Codex token endpoint response is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const nonBlank = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value : undefined;
