import type { EngineHandler } from "./contract.js";
import { ENGINE_DESCRIPTORS, type EngineKind } from "./descriptors.js";
import { codexAuthHooks } from "./codex/authHooks.js";
import { codexConfigHooks } from "./codex/configHooks.js";
import { codexPiHooks } from "./codex/piHooks.js";
import { codexRuntimeHooks } from "./codex/runtimeHooks.js";
import { grokAuthHooks } from "./grok/authHooks.js";
import { grokConfigHooks } from "./grok/configHooks.js";
import { grokPiHooks } from "./grok/piHooks.js";
import { grokRuntimeHooks } from "./grok/runtimeHooks.js";
import { agyAuthHooks } from "./agy/authHooks.js";
import { agyConfigHooks } from "./agy/configHooks.js";
import { agyPiHooks } from "./agy/piHooks.js";
import { agyRuntimeHooks } from "./agy/runtimeHooks.js";

const handlers: Record<EngineKind, EngineHandler> = {
  codex: { id: ENGINE_DESCRIPTORS.codex.id, descriptor: ENGINE_DESCRIPTORS.codex, ...codexAuthHooks, ...codexConfigHooks, ...codexPiHooks, ...codexRuntimeHooks },
  grok: { id: ENGINE_DESCRIPTORS.grok.id, descriptor: ENGINE_DESCRIPTORS.grok, ...grokAuthHooks, ...grokConfigHooks, ...grokPiHooks, ...grokRuntimeHooks },
  agy: { id: ENGINE_DESCRIPTORS.agy.id, descriptor: ENGINE_DESCRIPTORS.agy, ...agyAuthHooks, ...agyConfigHooks, ...agyPiHooks, ...agyRuntimeHooks }
};

export const getEngineHandler = (id: EngineKind): EngineHandler => handlers[id];
export const engineHandlers = (): readonly EngineHandler[] => Object.values(handlers);
