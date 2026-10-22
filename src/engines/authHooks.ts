import type { EngineKind } from "./descriptors.js";

export type EngineAuthVerification = Readonly<{
  agentId: string;
  engine: EngineKind;
  engineHomePath: string;
  executablePath: string;
  runtimeHomePath: string;
  busAddress?: string;
}>;

export interface AuthEngineHooks {
  engineHomePath(runtimeHomePath: string): string;
  verifyAuth(input: EngineAuthVerification): Promise<void>;
  hasRefreshableCredential(bytes: Uint8Array): boolean;
  credentialSecretValues(bytes: Uint8Array): readonly string[];
}

export function credentialJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")); }
  catch { return undefined; }
}

export function credentialPairSecrets(pair: { access?: string; refresh?: string }): readonly string[] {
  return [...new Set([pair.access, pair.refresh].filter((entry): entry is string => entry !== undefined))];
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function firstString(
  value: Record<string, unknown> | undefined,
  names: readonly string[]
): string | undefined {
  for (const name of names) {
    if (typeof value?.[name] === "string" && value[name]!.length > 0) return value[name] as string;
  }
  return undefined;
}

export function firstNonBlankString(
  value: Record<string, unknown> | undefined,
  names: readonly string[]
): string | undefined {
  const candidate = firstString(value, names);
  return candidate !== undefined && candidate.trim().length > 0 ? candidate : undefined;
}
