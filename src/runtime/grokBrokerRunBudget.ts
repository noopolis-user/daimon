import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export class GrokBrokerRunLimit extends Error {
  constructor() { super("run_request_limit"); }
}

/** One broker realm lease owns this journal. Reserve durably BEFORE forwarding;
 * failed calls and credential retries consume capacity, never refund it.
 * Slot recycle must never remove this run-level file.
 */
export class GrokBrokerRunBudget {
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private constructor(readonly maximum: number, private readonly file: string, private used: number) {}

  static async open(maximum: number, file: string): Promise<GrokBrokerRunBudget> {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError("invalid run request cap");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let used = 0;
    try {
      const state = JSON.parse(await readFile(file, "utf8"));
      if (state.schema !== "daimon.run-requests.v1" || state.maximum !== maximum ||
          !Number.isSafeInteger(state.used) || state.used < 0 || state.used > maximum ||
          Object.keys(state).length !== 3) throw new Error("invalid run request checkpoint");
      used = state.used;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return new GrokBrokerRunBudget(maximum, file, used);
  }

  reserve(): Promise<void> {
    const reservation = this.tail.then(async () => {
      if (this.failed) throw new Error("run request checkpoint unavailable");
      if (this.used >= this.maximum) throw new GrokBrokerRunLimit();
      this.used += 1;
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ schema: "daimon.run-requests.v1", maximum: this.maximum, used: this.used }));
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, this.file);
        const directory = await open(path.dirname(this.file), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        this.failed = true;
        throw error;
      } finally { await rm(temporary, { force: true }); }
    });
    this.tail = reservation.catch(() => undefined);
    return reservation;
  }
}
