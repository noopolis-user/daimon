import { getEngineHandler } from "../engines/registry.js";
import type { EngineKind } from "../engines/descriptors.js";
import { readTaskClock } from "../runtime/taskClock.js";

export { codexTaskClockArgs } from "../engines/codex/piTaskClock.js";

/** Operational diagnostic only. Brokered Grok reports from its attested per-turn boundary. */
export function reportEngineTaskClockGap(engine: EngineKind): void {
  if (readTaskClock() === undefined) return;
  const gap = getEngineHandler(engine).taskClockGap;
  if (gap) console.warn(`daimon: task clock coverage gap engine=${engine}: ${gap}; native tools remain on real time; wake allowed`);
}
