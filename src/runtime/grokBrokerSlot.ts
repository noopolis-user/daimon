import { GROK_BROKER_TASK_CLOCK, type GrokWorkerConfigVariant } from "../contracts/grokBrokerTaskClock.js";

/** Canonical path in both broker and worker views; never a caller-selected file. */
export function brokerTaskClockFileFor(slot: number): string {
  if (!Number.isSafeInteger(slot) || slot < 0) throw new TypeError("invalid broker slot");
  return `${GROK_BROKER_TASK_CLOCK.rootDirectoryPath}/slot-${slot}/faketime`;
}

/** The pinned strict base exposes /run; its deny mounts must hide every peer clock. */
export function assertBrokerTaskClockIsolation(
  variant: GrokWorkerConfigVariant, slot: number, slots: readonly number[], denyPaths: readonly string[]
): void {
  if (variant !== "clocked") return;
  const own = brokerTaskClockFileFor(slot);
  const covers = (denied: string, file: string) => file === denied || file.startsWith(`${denied}/`);
  if (denyPaths.some((denied) => covers(denied, own))) throw new Error("own broker task clock is denied");
  for (const peer of slots) {
    if (peer !== slot && !denyPaths.some((denied) => covers(denied, brokerTaskClockFileFor(peer).slice(0, -"/faketime".length)))) {
      throw new Error("sibling broker task clock is not denied");
    }
  }
}
