import { readdir, readFile } from "node:fs/promises";

/**
 * Whether a Grok worker is running one of its own local tools right now,
 * read-only from `/proc`.
 *
 * The broker sees every model request (the proxy) and every MCP tool call (the
 * facade), but not the tools Grok runs in-process: `run_terminal_command`
 * executes as a child of the worker. Grok 1.0.34 advertises that tool with a
 * model-chosen timeout of up to 36 000 000 ms (default 120 000 ms), so a
 * command the model gave a long timeout is real work the broker cannot see,
 * and the idle watchdog (`grokEngineBrokerTurnEnd.ts`) used to end such a turn
 * as stalled ten minutes in.
 *
 * Every engine process carries the argv the launcher compiled — the outer
 * bubblewrap wrapper Grok re-executes into and the Grok process inside it —
 * so `--output-format streaming-messages-json` marks them. A live (non-zombie)
 * process owned by `uid` whose parent is such an engine process, and which is
 * not one itself, is a tool the worker started and is waiting on. Short-lived
 * helpers count too, which only delays an idle verdict by a poll.
 *
 * An unreadable `/proc` (or one mounted `hidepid`) answers `false`: the
 * watchdog then behaves exactly as it did without this signal.
 */
export async function grokWorkerToolProcessLive(uid: number, procRoot = "/proc"): Promise<boolean> {
  let entries: string[];
  try { entries = await readdir(procRoot); } catch { return false; }
  const owned = new Map<number, { parent: number; engine: boolean }>();
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const status = await readFile(`${procRoot}/${entry}/status`, "utf8");
      if (Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1]) !== uid) continue;
      if (/^State:\s+[ZX]/mu.test(status)) continue;
      const parent = Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]);
      if (!Number.isSafeInteger(parent)) continue;
      const argv = (await readFile(`${procRoot}/${entry}/cmdline`, "utf8")).split("\0");
      owned.set(Number(entry), { parent, engine: isGrokEngineArgv(argv) });
    } catch { /* a process exiting mid-scan is not part of the answer */ }
  }
  for (const process of owned.values()) {
    if (!process.engine && owned.get(process.parent)?.engine === true) return true;
  }
  return false;
}

/** The compiled worker argv pair every engine process of a brokered turn carries (`grokBrokerWorkerConfig.ts`). */
function isGrokEngineArgv(argv: readonly string[]): boolean {
  const flag = argv.indexOf("--output-format");
  return flag !== -1 && argv[flag + 1] === "streaming-messages-json";
}

/**
 * The watchdog's poll is synchronous and `/proc` is not, so the turn keeps the
 * last answer: `poll()` starts one read when none is pending, `live()` returns
 * the latest completed one. A failed read answers `false`, as an unreadable
 * `/proc` does.
 */
export function grokWorkerToolProcessSampler(read: () => Promise<boolean>): Readonly<{ poll(): void; live(): boolean }> {
  let live = false, pending = false;
  return {
    poll: () => {
      if (pending) return;
      pending = true;
      void Promise.resolve().then(read).then((value) => { live = value; }, () => { live = false; }).finally(() => { pending = false; });
    },
    live: () => live
  };
}
