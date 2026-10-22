/** Subscription authentication, model selection, and sandbox policy are engine-owned. */
export const AGY_CONFIG_CONDITION = {
  if: { properties: { kind: { const: "agy" } } },
  then: { properties: { model: false, reasoningEffort: false, codexSandbox: false } }
} as const;
