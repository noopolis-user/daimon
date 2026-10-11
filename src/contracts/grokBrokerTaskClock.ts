/** Fixed paths inside one clock-enabled container slot; never caller-selected. */
export const GROK_BROKER_TASK_CLOCK_PRELOAD_PATH = "/usr/local/lib/daimon/libfaketime.so.1";
export const GROK_BROKER_TASK_CLOCK_FILE_PATH = "/run/daimon-engine-broker/task-clock/faketime";
export const GROK_BROKER_TASK_CLOCK = {
  preloadPath: GROK_BROKER_TASK_CLOCK_PRELOAD_PATH,
  timestampFilePath: GROK_BROKER_TASK_CLOCK_FILE_PATH,
  directoryPath: "/run/daimon-engine-broker/task-clock",
  directoryMode: 0o755,
  fileMode: 0o644,
  ownerUid: 2100,
  maxRegistrations: 1
} as const;

export type GrokWorkerConfigVariant = "unclocked" | "clocked";
