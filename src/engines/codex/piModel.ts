import type { HarnessModelSpec } from "../../core/types.js";

/** Pi names its built-in OAuth provider independently of the model's source. */
export const resolveCodexPiProvider = (model: HarnessModelSpec): string | undefined =>
  model.provider === "openai" && model.auth?.method === "codex" ? "openai-codex" : undefined;
