/**
 * Preserve ordinary JSON bytes, including whitespace and escaping. Ambiguous
 * duplicate members still normalize to the validated values, as the spend gate
 * requires: an upstream parser must never select a different model or tool set.
 */
export function parseGrokBrokerProxyJson(body: Uint8Array): {
  value: Record<string, unknown>;
  body: Uint8Array;
} {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  let properties = 0;
  const value: unknown = JSON.parse(source, (key, entry: unknown) => {
    if (key === "__proto__") throw new Error("broker proxy request rejected");
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      properties += Object.keys(entry).length;
    }
    return entry;
  });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("broker proxy request rejected");
  }
  // JSON.parse established the grammar. Match whole string tokens (including
  // escaped quotes), so a colon inside message content cannot count as a key.
  let sourceProperties = 0;
  for (const token of source.matchAll(/"(?:[^"\\]|\\[\s\S])*"\s*(:)?/gu)) {
    if (token[1] !== undefined) sourceProperties++;
  }
  return {
    value: value as Record<string, unknown>,
    body: sourceProperties === properties ? body : Buffer.from(JSON.stringify(value))
  };
}
