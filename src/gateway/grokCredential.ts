import { createHash } from "node:crypto";

/** One Grok CLI `auth.json` login. `bytes` is a private copy of the CLI's own file, written back verbatim. */
export type GrokLogin = Readonly<{ bytes: Buffer; accessToken: string; refreshToken: string; expiresAt?: number; digest: string }>;

/** The CLI file holds exactly one login row: `{ <issuer>::<id>: { key, refresh_token, expires_at? } }`. */
export function parseGrokAuth(bytes: Uint8Array): GrokLogin {
  const copy = Buffer.from(bytes);
  try {
    const root = JSON.parse(copy.toString("utf8")) as Record<string, unknown>;
    const rows = Object.values(root ?? {}).filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value));
    const row = rows.length === 1 ? rows[0]! : undefined;
    if (row === undefined || typeof row.key !== "string" || row.key.length < 32 || typeof row.refresh_token !== "string" || row.refresh_token.length < 16) throw new Error();
    const expiresAt = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;
    return { bytes: copy, accessToken: row.key, refreshToken: row.refresh_token, digest: createHash("sha256").update(copy).digest("hex"), ...(Number.isFinite(expiresAt) ? { expiresAt } : {}) };
  } catch {
    copy.fill(0);
    throw new Error("Grok realm credential is not a refreshable login");
  }
}
