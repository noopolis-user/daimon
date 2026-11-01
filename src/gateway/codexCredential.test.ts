import assert from "node:assert/strict";
import test from "node:test";

import { codexAuthHooks } from "../engines/codex/authHooks.js";
import { accountIdFromIdToken, jwtExpiryMs, parseCodexAuth, renderCodexAuth } from "./codexCredential.js";

const jwt = (claims: Record<string, unknown>): string => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;

test("write-back renders the Codex CLI schema and round-trips through the parser", () => {
  const tokens = { idToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-synthetic" } }), accessToken: jwt({ exp: 2_000_000_000 }), refreshToken: "synthetic-refresh-token-0001", accountId: "acct-synthetic" };
  const bytes = renderCodexAuth(tokens, new Date("2026-11-01T00:00:00.000Z"));
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(value), ["OPENAI_API_KEY", "auth_mode", "tokens", "last_refresh"]);
  assert.equal(value.OPENAI_API_KEY, null);
  assert.equal(value.auth_mode, "chatgpt");
  assert.equal(value.last_refresh, "2026-11-01T00:00:00.000Z");
  assert.deepEqual(Object.keys(value.tokens as object), ["id_token", "access_token", "refresh_token", "account_id"]);
  assert.deepEqual(parseCodexAuth(bytes), tokens);
  assert.equal(codexAuthHooks.hasRefreshableCredential(bytes), true, "the realm's own validator accepts a gateway-written file");
});

test("reads expiry and account id from JWT claims and tolerates opaque tokens", () => {
  assert.equal(jwtExpiryMs(jwt({ exp: 1_800_000_000 })), 1_800_000_000_000);
  assert.equal(jwtExpiryMs("opaque-token"), undefined);
  assert.equal(accountIdFromIdToken(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })), "acct-1");
  assert.equal(parseCodexAuth(Buffer.from(JSON.stringify({ tokens: { access_token: "a-synthetic", refresh_token: "r-synthetic", id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-2" } }) } }))).accountId, "acct-2");
  assert.throws(() => parseCodexAuth(Buffer.from(JSON.stringify({ tokens: { access_token: "only-access" } }))), /not a refreshable/u);
});
