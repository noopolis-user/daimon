export type BrokerCredentialJournal = Readonly<{ version: "noopolis.daimon.broker-credential-journal.v1"; state: "refreshing" | "promoted" | "stale"; generation: number; sourceDigest: string; promotedDigest?: string; ancestorDigests?: readonly string[] }>;
// At most 61 KiB including the rest of the record; all readers allow 64 KiB.
export const BROKER_CREDENTIAL_MAX_ANCESTORS = 900;
const DIGEST = /^[a-f0-9]{64}$/u;

export function parseBrokerCredentialJournal(value: unknown): BrokerCredentialJournal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid credential journal");
  const input = value as Record<string, unknown>; const fields = input.state === "refreshing" ? ["version", "state", "generation", "sourceDigest"] : ["version", "state", "generation", "sourceDigest", "promotedDigest"];
  if (Object.hasOwn(input, "ancestorDigests")) {
    fields.push("ancestorDigests");
    if (!Array.isArray(input.ancestorDigests) || input.ancestorDigests.length > BROKER_CREDENTIAL_MAX_ANCESTORS ||
      input.ancestorDigests.some((entry) => typeof entry !== "string" || !DIGEST.test(entry)) ||
      new Set(input.ancestorDigests).size !== input.ancestorDigests.length) throw new TypeError("invalid credential journal");
  }
  if (Object.keys(input).length !== fields.length || fields.some((key) => !Object.hasOwn(input, key)) || input.version !== "noopolis.daimon.broker-credential-journal.v1" || !["refreshing", "promoted", "stale"].includes(String(input.state)) || !Number.isSafeInteger(input.generation) || (input.generation as number) < 0 || !DIGEST.test(String(input.sourceDigest)) || (input.state !== "refreshing" && !DIGEST.test(String(input.promotedDigest)))) throw new TypeError("invalid credential journal");
  return input as BrokerCredentialJournal;
}

export function recoverBrokerCredentialJournal(journal: BrokerCredentialJournal, authorityDigest: string): "ready" | "stale" {
  if (journal.state === "stale") return "stale";
  if (journal.state === "refreshing") return authorityDigest === journal.sourceDigest ? "ready" : "stale";
  return authorityDigest === journal.promotedDigest ? "ready" : "stale";
}
