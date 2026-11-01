import assert from "node:assert/strict";
import test from "node:test";

import { CLI_ENGINE_MAX_OUTPUT_BYTES } from "../../pi/cliSession.js";
import { decodeGrokHeadlessTurn } from "./grokHeadlessResult.js";

const decodeText = (output: string): string => decodeGrokHeadlessTurn(output).text;

const assistant = (text: string, stopReason: string = "end_turn", sessionId: string = "session-1") => ({
  type: "assistant", parent_tool_use_id: null, session_id: sessionId,
  message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] }
});

const result = (text: string, stopReason: string = "end_turn", sessionId: string = "session-1") => ({
  type: "result", subtype: "success", is_error: false, result: text, stop_reason: stopReason, session_id: sessionId
});

const stream = (...events: readonly unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n");

test("Grok message stream ignores multiple tool narrations and returns the exact matching terminal answer", () => {
  assert.equal(decodeText(stream(
    { type: "system", subtype: "init", session_id: "session-1" },
    { ...assistant("I'll inspect the room.", "tool_use"), message: {
      role: "assistant", stop_reason: "tool_use", content: [
        { type: "text", text: "I'll inspect the room." }, { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "one" } }
      ]
    } },
    { type: "user", parent_tool_use_id: null, session_id: "session-1", message: { role: "user", content: [{
      type: "tool_result", tool_use_id: "tool-1", content: "x".repeat(CLI_ENGINE_MAX_OUTPUT_BYTES * 2)
    }] } },
    { ...assistant("I need one more source.", "tool_use"), message: {
      role: "assistant", stop_reason: "tool_use", content: [
        { type: "text", text: "I need one more source." }, { type: "tool_use", id: "tool-2", name: "read_file", input: { path: "two" } }
      ]
    } },
    { type: "user", parent_tool_use_id: null, session_id: "session-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-2", content: "two" }] } },
    { ...assistant("publishable ACK"), message: { role: "assistant", stop_reason: "end_turn", content: [
      { type: "thinking", thinking: "compose" }, { type: "text", text: "publishable ACK" }
    ] } },
    result("publishable ACK")
  )), "publishable ACK");
  assert.equal(decodeText(stream(assistant("bounded final", "stop_sequence"), result("bounded final", "stop_sequence"))), "bounded final");
});

test("Grok message stream rejects cancelled, error, malformed, empty, and mismatched terminals without leaking text", () => {
  const canary = "progress-must-not-publish";
  for (const output of [
    stream(assistant(canary, "cancelled"), result(canary, "cancelled")),
    stream({ type: "error", message: canary }),
    stream(result(canary)),
    stream(assistant(canary), result("different")),
    stream(assistant(" "), result(" ")),
    stream(assistant(canary), { ...result(canary), errors: [canary] }),
    stream(assistant(canary), { ...result(canary), errors: canary }),
    stream(result(canary), assistant(canary)),
    stream({ ...assistant(canary), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "tool_use", id: "tool-1" }] } }, result(canary)),
    canary
  ]) {
    assert.throws(() => decodeText(output), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no publishable terminal response/);
      assert.equal(error.message.includes(canary), false);
      return true;
    });
  }
});

