import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import { jwtExpiryMs, parseCodexAuth, renderCodexAuth, type CodexTokens } from "./codexCredential.js";
import { CodexRefreshRejected, type CodexRefresh } from "./codexRefresh.js";
import { createRealmOwner, RealmAuthStale, RealmLost, type RealmBearer, type RealmOwner, type RealmOwnerOptions } from "./realmOwner.js";

export type CodexBearer = RealmBearer<{ accountId: string | undefined }>;
export type CodexRealmOwner = RealmOwner<{ accountId: string | undefined }>;
export type CodexRealmOwnerOptions = Omit<RealmOwnerOptions<CodexTokens>, "refresh" | "proactiveRefreshIntervalMs"> & Readonly<{ refresh: CodexRefresh }>;

/** The realm login cannot buy inference until an operator re-imports it. */
export const CodexAuthStale = RealmAuthStale;
/** The realm lease is gone; another process may now hold the login. */
export const CodexRealmLost = RealmLost;

/** Sole owner of one Codex realm login: single-flight refresh with atomic CLI-schema write-back. */
export function createCodexRealmOwner(options: CodexRealmOwnerOptions): Promise<CodexRealmOwner> {
  return createRealmOwner<CodexTokens, { accountId: string | undefined }>({
    label: ENGINE_DESCRIPTORS.codex.id,
    parse: parseCodexAuth,
    render: renderCodexAuth,
    accessToken: (tokens) => tokens.accessToken,
    extra: (tokens) => ({ accountId: tokens.accountId }),
    expiryMs: (tokens) => jwtExpiryMs(tokens.accessToken),
    secrets: (tokens) => [tokens.accessToken, tokens.refreshToken, tokens.idToken],
    same: (left, right) => left.accessToken === right.accessToken && left.refreshToken === right.refreshToken && left.idToken === right.idToken,
    refreshRejected: (error) => error instanceof CodexRefreshRejected
  }, options);
}
