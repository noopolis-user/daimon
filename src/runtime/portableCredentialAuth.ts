import { getEngineHandler } from "../engines/registry.js";
import type { PortableEngineKind } from "../engines/descriptors.js";

export type PortableCredentialKind = PortableEngineKind;

/** Validates only the bounded provider-native shape needed for refresh. */
export function hasRefreshablePortableCredential(engine: PortableCredentialKind, bytes: Uint8Array): boolean {
  return getEngineHandler(engine).hasRefreshableCredential(bytes);
}

/** Returns only the provider-native bearer values for exact in-process redaction. */
export function portableCredentialSecretValues(engine: PortableCredentialKind, bytes: Uint8Array): readonly string[] {
  return getEngineHandler(engine).credentialSecretValues(bytes);
}
