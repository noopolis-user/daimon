import path from "node:path";
import { credentialJson, credentialPairSecrets, firstNonBlankString, object, type AuthEngineHooks } from "../authHooks.js";
import { verifyPortableEngineAuth } from "../../runtime/engineReadiness.js";

export const codexAuthHooks: AuthEngineHooks = {
  engineHomePath: (runtimeHomePath) => path.join(runtimeHomePath, ".codex"),
  verifyAuth: ({ agentId, engineHomePath }) => verifyPortableEngineAuth(agentId, "codex", engineHomePath),
  hasRefreshableCredential(bytes) {
    const pair = tokenPair(credentialJson(bytes));
    return pair.access !== undefined && pair.refresh !== undefined;
  },
  credentialSecretValues: (bytes) => credentialPairSecrets(tokenPair(credentialJson(bytes)))
};

function tokenPair(value: unknown): { access?: string; refresh?: string } {
  const source = object(value);
  const nested = object(source?.tokens) ?? source;
  return {
    access: firstNonBlankString(nested, ["access_token", "accessToken", "token"]),
    refresh: firstNonBlankString(nested, ["refresh_token", "refreshToken"])
  };
}
