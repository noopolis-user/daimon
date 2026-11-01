import type { PortableRealmAuthority } from "../runtime/portableSubscriptionRealmTypes.js";
import { jwtExpiryMs, parseCodexAuth, renderCodexAuth, type CodexTokens } from "./codexCredential.js";
import { CodexRefreshRejected, type CodexRefresh } from "./codexRefresh.js";

export type CodexBearer = Readonly<{ accessToken: string; accountId: string | undefined; generation: number }>;

/** The realm login cannot buy inference until an operator re-imports it. */
export class CodexAuthStale extends Error {
  constructor() { super("auth_stale"); }
}

/** The realm lease is gone; another process may now hold the login. */
export class CodexRealmLost extends Error {
  constructor() { super("realm_unavailable"); }
}

export type CodexRealmOwner = Readonly<{
  /** The current bearer, refreshed first when it is about to expire. */
  bearer(): Promise<CodexBearer>;
  /** Upstream refused `rejected`: refresh once (shared by every caller) or fail stale. */
  rejected(rejected: CodexBearer): Promise<CodexBearer>;
  /** A refreshed bearer was still refused: fence the realm instead of refreshing per request. */
  fence(): Promise<void>;
  stale(): boolean;
  /** The realm lease is still held; a lost lease refuses every bearer. */
  live(): boolean;
  /** A refreshed login is not yet durable in the realm; retried until it is. */
  writeBackPending(): boolean;
  /** Exact token values for redaction; never leaves the process. */
  secrets(): readonly string[];
  close(): void;
}>;

export type CodexRealmOwnerOptions = Readonly<{
  authority: PortableRealmAuthority;
  refresh: CodexRefresh;
  now?: () => number;
  refreshSkewMs?: number;
  writeBackRetryMs?: number;
  log?: (line: string) => void;
}>;

const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_WRITE_BACK_RETRY_MS = 5_000;

/** Sole owner of one Codex realm login: single-flight refresh with atomic CLI-schema write-back. */
export async function createCodexRealmOwner(options: CodexRealmOwnerOptions): Promise<CodexRealmOwner> {
  const now = options.now ?? Date.now;
  const skew = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const authority = options.authority;
  const bytes = await authority.read();
  let tokens: CodexTokens;
  try { tokens = parseCodexAuth(bytes); } finally { bytes.fill(0); }
  let generation = 0;
  let stale = false;
  let inflight: Promise<CodexBearer> | undefined;
  // Bytes of a refreshed login that the realm does not hold yet; the old refresh token on disk is dead.
  let pending: Buffer | undefined;
  let flushing: Promise<void> | undefined;
  let retry: NodeJS.Timeout | undefined;

  const live = (): boolean => { try { authority.assertLive(); return true; } catch { return false; } };
  const assertLive = (): void => { if (!live()) throw new CodexRealmLost(); };
  // Writes are serialized and always carry the newest login, so an older one can never land last.
  const flush = (): Promise<void> => flushing ??= (async () => {
    try {
      await null; // settle the assignment above before `finally` can clear it
      const bytes = pending;
      if (bytes === undefined) return;
      await authority.replace(bytes);
      if (pending === bytes) {
        pending = undefined;
        bytes.fill(0);
        if (retry !== undefined) { clearInterval(retry); retry = undefined; log("daimon gateway: codex realm write-back recovered"); }
      }
    } catch {
      // Still pending: the timer and the next bearer() try again.
    } finally {
      flushing = undefined;
    }
  })();
  const writeBack = async (next: CodexTokens): Promise<void> => {
    pending = renderCodexAuth(next, new Date(now()));
    await flushing;
    await flush();
    if (pending === undefined || retry !== undefined) return;
    log("daimon gateway: codex realm write-back failed; retrying, readiness refuses until it lands");
    retry = setInterval(() => { void flush(); }, options.writeBackRetryMs ?? DEFAULT_WRITE_BACK_RETRY_MS);
    retry.unref();
  };
  const fence = async (): Promise<void> => {
    if (stale) return;
    stale = true;
    await authority.markStale().catch(() => log("daimon gateway: codex realm stale fence could not be written"));
    log("daimon gateway: codex realm login was refused; realm is stale");
  };
  const current = (): CodexBearer => ({ accessToken: tokens.accessToken, accountId: tokens.accountId, generation });
  const refreshOnce = (): Promise<CodexBearer> => inflight ??= (async () => {
    try {
      const next = await Promise.resolve().then(() => options.refresh(tokens));
      tokens = next;
      generation += 1;
      await writeBack(next);
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
      assertLive();
      if (stale) throw new CodexAuthStale();
      if (pending !== undefined) await flush();
      if (inflight !== undefined) return inflight.catch(() => { if (stale) throw new CodexAuthStale(); return current(); });
      const expiry = jwtExpiryMs(tokens.accessToken);
      if (expiry === undefined || expiry - now() > skew) return current();
      try { return await refreshOnce(); } catch {
        if (stale) throw new CodexAuthStale();
        return current();
      }
    },
    async rejected(rejected) {
      assertLive();
      if (stale) throw new CodexAuthStale();
      if (rejected.generation < generation) return current();
      try { return await refreshOnce(); } catch { throw new CodexAuthStale(); }
    },
    fence,
    stale: () => stale,
    live,
    writeBackPending: () => pending !== undefined,
    secrets: () => [tokens.accessToken, tokens.refreshToken, tokens.idToken].filter((value) => value.length > 0),
    close: () => { clearInterval(retry); retry = undefined; }
  };
}
