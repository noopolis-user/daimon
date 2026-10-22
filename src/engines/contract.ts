import type { AuthEngineHooks } from "./authHooks.js";
import type { ConfigEngineHooks } from "./configHooks.js";
import type { EngineKind, ENGINE_DESCRIPTORS } from "./descriptors.js";
import type { PiEngineHooks } from "./piHooks.js";
import type { RuntimeEngineHooks } from "./runtimeHooks.js";

/** Executable per-engine boundary; static inventory is deliberately separate. */
export interface EngineHandler extends AuthEngineHooks, ConfigEngineHooks, PiEngineHooks, RuntimeEngineHooks {
  readonly id: EngineKind;
  readonly descriptor: typeof ENGINE_DESCRIPTORS[EngineKind];
}
