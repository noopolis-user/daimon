import { ENGINE_DESCRIPTORS } from "../descriptors.js";
import path from "node:path";
import { credentialJson, credentialPairSecrets, firstNonBlankString, object, type AuthEngineHooks } from "../authHooks.js";
import { verifyPortableEngineAuth } from "../../runtime/engineReadiness.js";

export const codexAuthHooks: AuthEngineHooks = {
  engineHomePath: (runtimeHomePath) => path.join(runtimeHomePath, ENGINE_DESCRIPTORS.codex.homeDirectory),
  verifyAuth: ({ agentId, engineHomePath }) => verifyPortableEngineAuth(agentId, "codex", engineHomePath),
  hasRefreshableCredential(bytes) {
    const pair = tokenPair(credentialJson(bytes));
    return pair.access !== undefined && pair.refresh !== undefined;
  },
  credentialSecretValues: (bytes) => credentialPairSecrets(tokenPair(credentialJson(bytes)))
};

function tokenPair(value: unknown): { access?: string; refresh?: string } {
  const source = object(value);
  const nested = object(source?.[ENGINE_DESCRIPTORS.codex.auth.format.containerKey]) ?? (ENGINE_DESCRIPTORS.codex.auth.format.fallbackToRoot ? source : undefined);
  return {
    access: firstNonBlankString(nested, ENGINE_DESCRIPTORS.codex.auth.format.accessTokenKeys),
    refresh: firstNonBlankString(nested, ENGINE_DESCRIPTORS.codex.auth.format.refreshTokenKeys)
  };
}
