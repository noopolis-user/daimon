import { ENGINE_DESCRIPTORS } from "../descriptors.js";
import path from "node:path";
import { credentialJson, firstNonBlankString, firstString, object, type AuthEngineHooks } from "../authHooks.js";

export const grokAuthHooks: AuthEngineHooks = {
  engineHomePath: (runtimeHomePath) => path.join(runtimeHomePath, ENGINE_DESCRIPTORS.grok.homeDirectory),
  hasRefreshableCredential(bytes) {
    const value = credentialJson(bytes);
    const pair = grokTokenPair(value);
    if (pair.access === undefined || pair.refresh === undefined) return false;
    const candidate = firstString(grokTokenEntry(value), [ENGINE_DESCRIPTORS.grok.auth.format.expiresAtKey]);
    return candidate !== undefined && Number.isFinite(Date.parse(candidate));
  }
};

function grokTokenEntry(value: unknown): Record<string, unknown> | undefined {
  const source = object(value);
  if (source === undefined) return undefined;
  for (const [key, entry] of Object.entries(source)) {
    if (new RegExp(ENGINE_DESCRIPTORS.grok.auth.format.entryKeyPattern, "u").test(key)) return object(entry);
  }
  return undefined;
}

function grokTokenPair(value: unknown): { access?: string; refresh?: string } {
  const entry = grokTokenEntry(value);
  return {
    access: firstNonBlankString(entry, ENGINE_DESCRIPTORS.grok.auth.format.accessTokenKeys),
    refresh: firstNonBlankString(entry, ENGINE_DESCRIPTORS.grok.auth.format.refreshTokenKeys)
  };
}
