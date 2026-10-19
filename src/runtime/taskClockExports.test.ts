import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskClock, TASK_CLOCK_VERSION } from "./index.js";
import { parseTaskClock as implementation, TASK_CLOCK_VERSION as version } from "./taskClock.js";

test("public runtime task-clock exports preserve the existing parser and version", () => {
  assert.equal(parseTaskClock, implementation);
  assert.equal(TASK_CLOCK_VERSION, version);
  assert.equal(TASK_CLOCK_VERSION, "noopolis.task-clock.v1");
  const origin = "2024-01-01T00:00:00Z";
  assert.equal(parseTaskClock(JSON.stringify({ version: TASK_CLOCK_VERSION, origin, anchorEpochMs: 100 }))!.at(125), Date.parse(origin) + 25);
});
