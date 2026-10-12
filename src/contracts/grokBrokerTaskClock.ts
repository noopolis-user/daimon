/** Slot zero pins the clocked template; every other slot replaces only its canonical directory. */
export const GROK_BROKER_TASK_CLOCK_PRELOAD_PATH = "/usr/local/lib/daimon/libfaketime.so.1";
export const GROK_BROKER_TASK_CLOCK_FILE_PATH = "/run/daimon-engine-broker/task-clock/slot-0/faketime";
export const GROK_BROKER_TASK_CLOCK = {
  preloadPath: GROK_BROKER_TASK_CLOCK_PRELOAD_PATH,
  timestampFilePath: GROK_BROKER_TASK_CLOCK_FILE_PATH,
  directoryPath: "/run/daimon-engine-broker/task-clock/slot-0",
  rootDirectoryPath: "/run/daimon-engine-broker/task-clock",
  directoryMode: 0o755,
  fileMode: 0o644,
  ownerUid: 2100,
  version: "noopolis.daimon.grok-broker-task-clock.v2",
  slotDirectoryPattern: "/run/daimon-engine-broker/task-clock/slot-{slot}",
  slotFilePattern: "/run/daimon-engine-broker/task-clock/slot-{slot}/faketime",
  workerView: "own-directory-visible-sibling-directories-denied"
} as const;

export type GrokWorkerConfigVariant = "unclocked" | "clocked";
