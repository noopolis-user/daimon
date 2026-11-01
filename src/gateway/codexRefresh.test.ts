import assert from "node:assert/strict";
import test from "node:test";

import { CodexRefreshRejected, createCodexRefresh } from "./codexRefresh.js";

const current = { idToken: "", accessToken: "synthetic-access-0", refreshToken: "synthetic-refresh-0", accountId: "acct-synthetic" };
const answering = (status: number, body: unknown): typeof fetch => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;

test("only a named refusal of the login is a rejection", async () => {
  for (const [status, body] of [[400, { error: "invalid_grant" }], [401, { error: { code: "refresh_token_reused" } }], [400, { error: "refresh_token_expired" }], [401, { code: "token_revoked" }], [400, { error: { code: "refresh_token_invalidated", message: "x" } }]] as const) {
    await assert.rejects(createCodexRefresh({ fetch: answering(status, body) })(current), CodexRefreshRejected, `${status} ${JSON.stringify(body)}`);
  }
  for (const [status, body] of [[429, { error: "invalid_grant" }], [408, { error: "refresh_token_reused" }], [400, { error: "invalid_request" }], [401, "not json"], [403, { error: "invalid_grant" }], [500, { error: "invalid_grant" }]] as const) {
    await assert.rejects(createCodexRefresh({ fetch: answering(status, body) })(current), (error: Error) => !(error instanceof CodexRefreshRejected), `${status} ${JSON.stringify(body)}`);
  }
});
