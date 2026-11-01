import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import { parseGrokAuth, type GrokLogin } from "./grokCredential.js";
import { GrokRefreshRejected, type GrokRefresh } from "./grokRefresh.js";
import { createRealmOwner, type RealmBearer, type RealmOwner, type RealmOwnerOptions } from "./realmOwner.js";

export type GrokBearer = RealmBearer;
export type GrokRealmOwner = RealmOwner;
export type GrokRealmOwnerOptions = Omit<RealmOwnerOptions<GrokLogin>, "refresh"> & Readonly<{ refresh: GrokRefresh }>;

/** `grok models` may leave an unexpired login untouched, so proactive attempts are spaced. */
const PROACTIVE_REFRESH_INTERVAL_MS = 60_000;

/**
 * Sole owner of one Grok realm login. Refresh is the CLI's own (`grokRefresh.ts`);
 * the CLI file is written back byte for byte, so the realm stays a valid CLI login.
 */
export function createGrokRealmOwner(options: GrokRealmOwnerOptions): Promise<GrokRealmOwner> {
  return createRealmOwner<GrokLogin, object>({
    label: ENGINE_DESCRIPTORS.grok.id,
    parse: parseGrokAuth,
    render: (login) => Buffer.from(login.bytes),
    accessToken: (login) => login.accessToken,
    extra: () => ({}),
    expiryMs: (login) => login.expiresAt,
    secrets: (login) => [login.accessToken, login.refreshToken],
    refreshRejected: (error) => error instanceof GrokRefreshRejected
  }, { proactiveRefreshIntervalMs: PROACTIVE_REFRESH_INTERVAL_MS, ...options });
}
