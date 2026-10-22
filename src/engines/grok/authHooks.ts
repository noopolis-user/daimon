import path from "node:path";
import { credentialJson, credentialPairSecrets, firstNonBlankString, firstString, object, type AuthEngineHooks } from "../authHooks.js";
import { verifyPortableEngineAuth } from "../../runtime/engineReadiness.js";

export const grokAuthHooks: AuthEngineHooks = {
  engineHomePath: (runtimeHomePath) => path.join(runtimeHomePath, ".grok"),
  verifyAuth: ({ agentId, engineHomePath }) => verifyPortableEngineAuth(agentId, "grok", engineHomePath),
  hasRefreshableCredential(bytes) {
    const value = credentialJson(bytes);
    const pair = grokTokenPair(value);
    if (pair.access === undefined || pair.refresh === undefined) return false;
    const candidate = firstString(grokTokenEntry(value), ["expires_at"]);
    return candidate !== undefined && Number.isFinite(Date.parse(candidate));
  },
  credentialSecretValues: (bytes) => credentialPairSecrets(grokTokenPair(credentialJson(bytes)))
};

function grokTokenEntry(value: unknown): Record<string, unknown> | undefined {
  const source = object(value);
  if (source === undefined) return undefined;
  for (const [key, entry] of Object.entries(source)) {
    if (/^https:\/\/auth\.x\.ai::/u.test(key)) return object(entry);
  }
  return undefined;
}

function grokTokenPair(value: unknown): { access?: string; refresh?: string } {
  const entry = grokTokenEntry(value);
  return {
    access: firstNonBlankString(entry, ["key"]),
    refresh: firstNonBlankString(entry, ["refresh_token"])
  };
}
