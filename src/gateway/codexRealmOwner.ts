import type { PortableRealmAuthority } from "../runtime/portableSubscriptionRealmTypes.js";
import { jwtExpiryMs, parseCodexAuth, renderCodexAuth, type CodexTokens } from "./codexCredential.js";
import { CodexRefreshRejected, type CodexRefresh } from "./codexRefresh.js";

export type CodexBearer = Readonly<{ accessToken: string; accountId: string | undefined; generation: number }>;

/** The realm login cannot buy inference until an operator re-imports it. */
export class CodexAuthStale extends Error {
  constructor() { super("auth_stale"); }
}

export type CodexRealmOwner = Readonly<{
  /** The current bearer, refreshed first when it is about to expire. */
  bearer(): Promise<CodexBearer>;
  /** Upstream refused `rejected`: refresh once (shared by every caller) or fail stale. */
  rejected(rejected: CodexBearer): Promise<CodexBearer>;
  /** A refreshed bearer was still refused: fence the realm instead of refreshing per request. */
  fence(): Promise<void>;
  stale(): boolean;
  /** Exact token values for redaction; never leaves the process. */
  secrets(): readonly string[];
}>;

export type CodexRealmOwnerOptions = Readonly<{
  authority: PortableRealmAuthority;
  refresh: CodexRefresh;
  now?: () => number;
  refreshSkewMs?: number;
  log?: (line: string) => void;
}>;

const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

/** Sole owner of one Codex realm login: single-flight refresh with atomic CLI-schema write-back. */
export async function createCodexRealmOwner(options: CodexRealmOwnerOptions): Promise<CodexRealmOwner> {
  const now = options.now ?? Date.now;
  const skew = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const bytes = await options.authority.read();
  let tokens: CodexTokens;
  try { tokens = parseCodexAuth(bytes); } finally { bytes.fill(0); }
  let generation = 0;
  let stale = false;
  let inflight: Promise<CodexBearer> | undefined;

  const fence = async (): Promise<void> => {
    if (stale) return;
    stale = true;
    await options.authority.markStale().catch(() => log("daimon gateway: codex realm stale fence could not be written"));
    log("daimon gateway: codex realm login was refused; realm is stale");
  };
  const current = (): CodexBearer => ({ accessToken: tokens.accessToken, accountId: tokens.accountId, generation });
  const refreshOnce = (): Promise<CodexBearer> => inflight ??= (async () => {
    try {
      const next = await Promise.resolve().then(() => options.refresh(tokens));
      tokens = next;
      generation += 1;
      try {
        await options.authority.replace(renderCodexAuth(next, new Date(now())));
      } catch {
        // The rotated refresh token now lives only here; keep serving and say so.
        log("daimon gateway: codex realm write-back failed; the refreshed login is held in memory only");
      }
      return current();
    } catch (error) {
      if (error instanceof CodexRefreshRejected) await fence();
      throw error;
    } finally {
      inflight = undefined;
    }
  })();

  return {
    async bearer() {
      if (stale) throw new CodexAuthStale();
      if (inflight !== undefined) return inflight.catch(() => { if (stale) throw new CodexAuthStale(); return current(); });
      const expiry = jwtExpiryMs(tokens.accessToken);
      if (expiry === undefined || expiry - now() > skew) return current();
      try { return await refreshOnce(); } catch {
        if (stale) throw new CodexAuthStale();
        return current();
      }
    },
    async rejected(rejected) {
      if (stale) throw new CodexAuthStale();
      if (rejected.generation < generation) return current();
      try { return await refreshOnce(); } catch { throw new CodexAuthStale(); }
    },
    fence,
    stale: () => stale,
    secrets: () => [tokens.accessToken, tokens.refreshToken, tokens.idToken].filter((value) => value.length > 0)
  };
}
