import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { GROK_BROKER_TASK_CLOCK, type GrokWorkerConfigVariant } from "../contracts/grokBrokerTaskClock.js";
import { readTaskClock, taskClockChildEnvironment } from "./taskClock.js";
import type { GrokBrokerProviderClockObservation } from "./grokBrokerProviderClock.js";

export type BrokerShellClock = "task" | "real" | "gap";
export type BrokerShellClockObservation = Readonly<{ shellClock?: BrokerShellClock }>;
export type BrokerClockObservation = BrokerShellClockObservation & Readonly<{
  providerClock?: GrokBrokerProviderClockObservation;
}>;

export function brokerClockObservation(
  shellClock?: BrokerShellClock, providerClock?: GrokBrokerProviderClockObservation
): BrokerClockObservation {
  return {
    ...(shellClock === undefined ? {} : { shellClock }),
    ...(providerClock === undefined ? {} : { providerClock })
  };
}

/** Relative seconds only: never a date, speed, loader path or arbitrary environment. */
export function parseBrokerProcessClock(value: unknown): string {
  if (typeof value !== "string" || !/^[+-](?:0|[1-9][0-9]{0,12})(?:\.[0-9]{3})?$/u.test(value)) throw new TypeError("invalid broker process clock");
  return value;
}

/** Daimon remains the offset owner; the broker uses its pinned library, not ambient preload. */
export function brokerProcessClock(): string | undefined {
  const clock = readTaskClock();
  clock?.now();
  return taskClockChildEnvironment({}, clock, { LD_PRELOAD: GROK_BROKER_TASK_CLOCK.preloadPath }).FAKETIME;
}

export function assertBrokerTaskClockSlot(variant: GrokWorkerConfigVariant, registrations: number): void {
  if (variant === "clocked" && registrations !== GROK_BROKER_TASK_CLOCK.maxRegistrations) {
    throw new Error("Grok broker task clock requires one registration per container slot");
  }
}

/** Pure provisioning seam: only the broker can replace entries; every worker can read. */
export function assertBrokerTaskClockDirectory(entry: Pick<Stats, "uid" | "mode" | "isDirectory">, brokerUid: number = GROK_BROKER_TASK_CLOCK.ownerUid): void {
  if (!entry.isDirectory() || entry.uid !== brokerUid || (entry.mode & 0o7777) !== GROK_BROKER_TASK_CLOCK.directoryMode) {
    throw new Error("unsafe Grok broker task clock directory");
  }
}

/**
 * Root provisions a non-symlink broker-owned directory. Rename publishes a
 * complete value before launch; binding the DIRECTORY (not the old file inode)
 * into the worker view keeps subsequent turns visible. No native ABI changes.
 * Paths/uid below are internal test seams, never control or service inputs.
 */
export async function writeBrokerTaskClock(value: string | undefined, file: string = GROK_BROKER_TASK_CLOCK.timestampFilePath, brokerUid: number = GROK_BROKER_TASK_CLOCK.ownerUid): Promise<void> {
  const seconds = value === undefined ? "+0" : parseBrokerProcessClock(value);
  const directory = path.dirname(file);
  const before = await lstat(directory);
  assertBrokerTaskClockDirectory(before, brokerUid);
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const temporary = path.join(directory, `.faketime-${randomUUID()}.tmp`);
  let created = false;
  try {
    const pinned = await parent.stat();
    const verify = async () => {
      const current = await lstat(directory);
      assertBrokerTaskClockDirectory(current, brokerUid);
      if (current.dev !== pinned.dev || current.ino !== pinned.ino || before.dev !== pinned.dev || before.ino !== pinned.ino) throw new Error("Grok broker task clock directory changed");
    };
    await verify();
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, GROK_BROKER_TASK_CLOCK.fileMode);
    created = true;
    try {
      const entry = await handle.stat();
      if (entry.uid !== brokerUid || !entry.isFile() || entry.nlink !== 1) throw new Error("unsafe Grok broker task clock file");
      await handle.chmod(GROK_BROKER_TASK_CLOCK.fileMode); // restrictive broker umask must not hide the file from the worker
      await handle.writeFile(`${seconds}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await verify();
    await rename(temporary, file);
    created = false;
    await parent.sync();
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
    await parent.close();
  }
}

/** Unknown config is never called clocked: this runs only after byte attestation. */
export async function prepareBrokerTaskClock(variant: GrokWorkerConfigVariant, value: string | undefined, write: typeof writeBrokerTaskClock = writeBrokerTaskClock): Promise<BrokerShellClock> {
  if (value !== undefined) parseBrokerProcessClock(value);
  if (variant === "clocked") {
    await write(value);
    return value === undefined ? "real" : "task";
  }
  if (value === undefined) return "real";
  console.warn("daimon: task clock coverage gap engine=grok: attested broker worker config is unclocked; native tools remain on real time; wake allowed");
  return "gap";
}
