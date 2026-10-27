/** One account's refresh critical section. Waiting consumes no CLI turn budget. */
export function createSubscriptionTurnGate(options: Readonly<{
  assertLive?: () => void;
  maxWaitMs?: number;
  maxQueued?: number;
}> = {}) {
  type Waiter = { start(): void; reject(error: Error): void };
  const pending: Waiter[] = [];
  let active = false;
  let closed = false;
  let onIdle: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  const stopped = () => new Error("subscription credential authority is stopped");
  const dispatch = (): void => {
    if (active) return;
    const next = pending.shift();
    if (next !== undefined) next.start();
    else if (closed) onIdle?.();
  };
  return {
    run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (closed) return Promise.reject(stopped());
      if (signal?.aborted) return Promise.reject(new Error("subscription credential wait aborted"));
      try { options.assertLive?.(); } catch (error) { return Promise.reject(error); }
      if (pending.length >= (options.maxQueued ?? 128)) return Promise.reject(new Error("subscription credential queue is full"));
      return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
        const cancel = (error: Error): void => {
          const index = pending.indexOf(waiter);
          if (index === -1) return;
          pending.splice(index, 1);
          cleanup();
          reject(error);
        };
        const abort = (): void => cancel(new Error("subscription credential wait aborted"));
        const waiter: Waiter = {
          reject: cancel,
          start() {
            cleanup();
            active = true;
            void (async () => {
              try {
                if (closed) throw stopped();
                options.assertLive?.();
                resolve(await operation());
              } catch (error) { reject(error); }
              finally { active = false; dispatch(); }
            })();
          }
        };
        pending.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => cancel(new Error("subscription credential wait exceeded 30 minute bound")), options.maxWaitMs ?? 30 * 60_000);
        dispatch();
      });
    },
    close(): Promise<void> {
      return closePromise ??= new Promise<void>((resolve) => {
        closed = true;
        onIdle = resolve;
        for (const waiter of [...pending]) waiter.reject(stopped());
        if (!active) resolve();
      });
    }
  };
}
