import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCliSessionFactory } from "./cliSession.js";

// Removal-failure semantics are exercised through AGY's `mcp remove`; Grok never spawns here.
const agyStream = (text: string): string => JSON.stringify({ event: "result", result: { conversation_id: "fake", status: "SUCCESS", response: text, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 } } });

test("MCP removal failure rejects without emitting a successful turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-agy-remove-failure-"));
  const grok = path.join(root, "grok.mjs");
  await writeFile(grok, `const args = process.argv.slice(2); if (args.includes("remove")) process.exit(23); else if (args.includes("add")) process.exit(0); else process.stdout.write(${JSON.stringify(agyStream("engine complete"))});`);
  try {
    const { session } = await createCliSessionFactory({ command: process.execPath, commandArgs: [grok], engine: "agy", maxToolTurns: 1, timeoutMs: 10_000 })({ cwd: root });
    let turns = 0;
    session.subscribe((event) => { if (event.type === "turn_end") turns += 1; });
    await assert.rejects(session.prompt("research"), /CLI engine exited 23/);
    assert.ok(session.disposeAsync);
    await assert.rejects(session.disposeAsync(), /CLI engine exited 23/);
    assert.equal(turns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

