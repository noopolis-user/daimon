import { ENGINE_DESCRIPTORS } from "../descriptors.js";
import type { HarnessModelSpec } from "../../core/types.js";

/** Pi names its built-in OAuth provider independently of the model's source. */
export const resolveCodexPiProvider = (model: HarnessModelSpec): string | undefined =>
  model.provider === ENGINE_DESCRIPTORS.codex.piSourceProvider && model.auth?.method === ENGINE_DESCRIPTORS.codex.piAuthMethod ? ENGINE_DESCRIPTORS.codex.piProvider : undefined;
