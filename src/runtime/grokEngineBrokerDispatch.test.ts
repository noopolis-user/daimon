import assert from "node:assert/strict";
import test from "node:test";
import { createGrokEngineBrokerTurnDispatch, type GrokBrokerActiveTurns, type GrokEngineBrokerRegistration } from "./grokEngineBroker.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("the broker forwards the clock and refuses overlapping wakes before either can change the slot file", async () => {
  const registration = { agentId: "agent" } as GrokEngineBrokerRegistration;
  const active: GrokBrokerActiveTurns = new Map();
  const gate = deferred();
  const seen: unknown[][] = [];
  const result = { text: "done", workerPid: 42, workerUid: 2200, workerStartTime: "1", outcome: "completed", usage: null, model: "grok-4.6", requests: 0, limitReason: "none" } as const;
  const dispatch = createGrokEngineBrokerTurnDispatch(new Map([["agent", registration]]), active, () => false, async (slot, ...args) => {
    seen.push([slot, ...args]);
    await gate.promise;
    return result;
  });
  const first = dispatch("agent", "one", "work", "http://127.0.0.1:1/mcp", undefined, { maxTokens: 10 }, "-123.456");
  const overlap = dispatch("agent", "two", "work", "http://127.0.0.1:1/mcp", undefined, undefined, "+0")
    .then(() => "admitted", (error: Error) => { assert.match(error.message, /already active/u); return "refused"; });
  try {
    const verdict = await Promise.race([overlap, new Promise<string>((resolve) => setImmediate(() => resolve("pending")))]);
    assert.equal(verdict, "refused", "the second turn must be refused while the first is still alive");
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.slice(5), [{ maxTokens: 10 }, "-123.456"]);
    assert.equal(active.size, 1);
  } finally { gate.resolve(); await Promise.allSettled([first, overlap]); }
  assert.deepEqual(await first, result);
  assert.equal(active.size, 0);
  await dispatch("agent", "two", "work", "http://127.0.0.1:1/mcp");
  assert.equal(seen[1]![6], undefined);
});

test("cancellation retains the identity claim until the prior turn actually finishes cleanup", async () => {
  const active: GrokBrokerActiveTurns = new Map();
  const cleanup = deferred();
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const dispatch = createGrokEngineBrokerTurnDispatch(new Map([["agent", { agentId: "agent" } as GrokEngineBrokerRegistration]]), active, () => false,
    async (_slot, _wake, _prompt, _endpoint, received) => { signal = received; await cleanup.promise; throw new Error("cancelled"); });
  const first = dispatch("agent", "one", "work", "http://127.0.0.1:1/mcp", controller.signal);
  const failed = assert.rejects(first, /cancelled/u);
  await Promise.resolve(); controller.abort();
  assert.equal(signal?.aborted, true);
  await assert.rejects(dispatch("agent", "two", "work", "http://127.0.0.1:1/mcp"), /already active/u);
  cleanup.resolve(); await failed;
  assert.equal(active.size, 0);
});
