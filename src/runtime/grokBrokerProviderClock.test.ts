import assert from "node:assert/strict";
import test from "node:test";
import { GrokBrokerProviderClock, parseGrokBrokerProviderClockObservation } from "./grokBrokerProviderClock.js";
import { parseEngineBrokerResponse, parseEngineBrokerV2TerminalResponse, ENGINE_BROKER_VERSION } from "./engineBrokerProtocol.js";

const info = (date: string): string => [
  "<user_info>", "OS Version: linux", "Shell: /bin/sh", "Workspace Path: /work/cwd",
  `Today's date: ${date}`,
  "Note: Prefer using relative paths over absolute paths as tool call args when possible.",
  "</user_info>"
].join("\n");

test("clock dates use request-time UTC across midnight in both directions and in resent history", () => {
  for (const [real, offset, expected] of [
    ["2026-10-11T00:00:00.000Z", "-0.001", "2026-10-10"],
    ["2026-10-11T23:59:59.999Z", "+0.001", "2026-10-12"]
  ]) {
    let now = Date.parse(real);
    const clock = new GrokBrokerProviderClock(offset, () => now);
    const original = {
      model: "grok-4.6", tools: [{ description: info("2026-10-11") }],
      messages: [
        { role: "system", content: info("2026-10-11") },
        { role: "assistant", content: info("2026-10-11") },
        { role: "tool", content: info("2026-10-11") },
        { role: "user", content: `Today's date: outside\n${info("2026-10-11")}\n${info("1999-12-31")}` },
        { role: "user", content: [
          { type: "text", text: info("2026-10-11").replaceAll("\n", "\r\n") },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" }, text: info("2026-10-11") },
          { type: "text", text: `unchanged: Today's date: 2026-10-11` }
        ] }
      ]
    };
    for (const [advance, date] of [[0, expected], [86_400_000, offset[0] === "-" ? "2026-10-11" : "2026-10-13"]] as const) {
      now = Date.parse(real) + advance;
      const wanted = structuredClone(original);
      wanted.messages[3]!.content = `Today's date: outside\n${info(date)}\n${info("1999-12-31")}`;
      const actual = clock.rewrite(Buffer.from(JSON.stringify(original)));
      assert.deepEqual(JSON.parse(Buffer.from(actual).toString()), wanted);
    }
    assert.deepEqual(clock.snapshot(), {
      requests: 2, linesRewritten: 2, requestsWithoutDateLine: 0, linesIgnored: 14,
      injectedDate: "2026-10-11", taskDate: offset[0] === "-" ? "2026-10-11" : "2026-10-13"
    });
  }
});

test("clock refuses changed injected date formats atomically, including content parts", () => {
  const clock = new GrokBrokerProviderClock("+0", () => Date.parse("2026-10-11T12:00Z"));
  for (const date of ["", "October 11, 2026", "2026-10-11T00:00:00Z", "2026-1-11", "2026-10-11 ", "2026-10-11 extra"]) {
    for (const content of [info(date), [{ type: "text", text: info(date) }]]) {
      const body = { messages: [
        { role: "system", content: info("2026-10-11") },
        { role: "assistant", content: "history" },
        { role: "user", content }
      ] };
      assert.throws(() => clock.rewrite(Buffer.from(JSON.stringify(body))), { reason: "task_clock_date_format" });
    }
  }
  assert.deepEqual(clock.snapshot(), {
    requests: 12, linesRewritten: 0, requestsWithoutDateLine: 0, linesIgnored: 0, injectedDate: null, taskDate: null
  });
});

test("wake prompt look-alikes and later history are left intact and counted, even with malformed date lines", () => {
  const clock = new GrokBrokerProviderClock("-0.001", () => Date.parse("2026-10-11T00:00Z"));
  const wake = `Study this example:\n${info("October 11, 2026")}\nToday's date: prompt text\n${info("1999-12-31")}`;
  for (const content of [
    `${info("2026-10-11")}\n${wake}`,
    [{ type: "text", text: info("2026-10-11").replaceAll("\n", "\r\n") }, { type: "text", text: `\n${wake}` }]
  ]) {
    const body = { messages: [
      { role: "user", content },
      { role: "assistant", content: info("TODAY") },
      { role: "user", content: info("Today's date = later") }
    ] };
    const expected = structuredClone(body);
    const first = expected.messages[0]!;
    if (typeof first.content === "string") first.content = first.content.replace("2026-10-11", "2026-10-10");
    else first.content[0]!.text = first.content[0]!.text.replace("2026-10-11", "2026-10-10");
    assert.deepEqual(JSON.parse(Buffer.from(clock.rewrite(Buffer.from(JSON.stringify(body)))).toString()), expected);
  }
  assert.deepEqual(clock.snapshot(), {
    requests: 2, linesRewritten: 2, requestsWithoutDateLine: 0, linesIgnored: 10,
    injectedDate: "2026-10-11", taskDate: "2026-10-10"
  });
});

test("missing injected dates never promote a prompt block or a later user message into the rewrite target", () => {
  for (const first of [
    "<user_info>\nCurrent date: 2026-10-11\n</user_info>\n" + info("2026-10-11"),
    "no injected block",
    [{ type: "image_url", image_url: { url: "image" } }]
  ]) {
    const clock = new GrokBrokerProviderClock("-1");
    const body = Buffer.from(JSON.stringify({ messages: [
      { role: "user", content: first }, { role: "user", content: info("October 11, 2026") }
    ] }));
    assert.deepEqual(clock.rewrite(body), body);
    assert.deepEqual(clock.snapshot(), {
      requests: 1, linesRewritten: 0, requestsWithoutDateLine: 1,
      linesIgnored: typeof first === "string" && first.startsWith("<user_info>") ? 2 : 1,
      injectedDate: null, taskDate: null
    });
  }
});

test("blocks and dates split across text parts rewrite without moving their boundaries", () => {
  const clock = new GrokBrokerProviderClock("-0.001", () => Date.parse("2026-10-11T00:00Z"));
  const content = [
    { type: "text", text: "<user_" },
    { type: "text", text: "info>\nToday's date: 2026-10-" },
    { type: "text", text: "11\n</user_info>" }
  ];
  const body = { messages: [{ role: "user", content }] };
  const actual = JSON.parse(Buffer.from(clock.rewrite(Buffer.from(JSON.stringify(body)))).toString());
  const expected = structuredClone(body);
  expected.messages[0]!.content[2]!.text = "10\n</user_info>";
  assert.deepEqual(actual, expected);
  content[2]!.text = "11T00:00Z\n</user_info>";
  assert.throws(() => clock.rewrite(Buffer.from(JSON.stringify(body))), { reason: "task_clock_date_format" });
});

test("date-label punctuation drift fails closed instead of looking like a missing date", () => {
  const clock = new GrokBrokerProviderClock("+0");
  for (const line of [
    "Today's date = 2026-10-11", "Today's date 2026-10-11", "Todays date: 2026-10-11",
    "Today’s date: 2026-10-11", "TODAY'S DATE: 2026-10-11", " Today's date: 2026-10-11"
  ]) {
    const body = { messages: [{ role: "user", content: `<user_info>\n${line}\n</user_info>` }] };
    assert.throws(() => clock.rewrite(Buffer.from(JSON.stringify(body))), { reason: "task_clock_date_format" });
  }
});

test("no target date leaves bytes intact and records absence without inventing dates", () => {
  const clock = new GrokBrokerProviderClock("+0");
  const body = Buffer.from(' { "messages" : [{"role":"user","content":"<user_info>\\nShell: /bin/sh\\n</user_info>"}] }\n');
  assert.deepEqual(clock.rewrite(body), body);
  assert.deepEqual(clock.snapshot(), {
    requests: 1, linesRewritten: 0, requestsWithoutDateLine: 1, linesIgnored: 0, injectedDate: null, taskDate: null
  });
});

test("out-of-range task dates refuse instead of producing truncated ISO years", () => {
  for (const [offset, now] of [["-0.001", 0], ["+0.001", 253_402_300_799_999]] as const) {
    const clock = new GrokBrokerProviderClock(offset, () => now);
    assert.throws(() => clock.rewrite(Buffer.from('{"messages":[]}')), { reason: "task_clock_date_range" });
  }
});

test("terminal clock observations are closed, dates-only, and optional on old seals", () => {
  const providerClock = {
    requests: 2, linesRewritten: 3, requestsWithoutDateLine: 1,
    injectedDate: "2026-10-11", taskDate: "2001-01-01"
  };
  const frame = {
    version: ENGINE_BROKER_VERSION, kind: "completed", requestId: "r", turnId: "t",
    text: "answer", workerPid: 42, workerUid: 2200, workerStartTime: "1",
    outcome: "completed", usage: null, model: "grok-4.6", requests: 2, limitReason: "none"
  };
  assert.deepEqual(parseEngineBrokerResponse({ ...frame, providerClock }), { ...frame, providerClock });
  const current = { ...providerClock, linesIgnored: 2 };
  assert.deepEqual(parseEngineBrokerResponse({ ...frame, providerClock: current }), { ...frame, providerClock: current });
  assert.deepEqual(parseEngineBrokerResponse(frame), frame);
  assert.throws(() => parseEngineBrokerV2TerminalResponse({ ...frame, version: "noopolis.daimon.engine-broker.v2", providerClock }));
  for (const changed of [
    { requests: -1 }, { linesRewritten: 0 }, { requestsWithoutDateLine: 3 },
    { linesIgnored: -1 }, { linesIgnored: 0.5 }, { linesIgnored: "1" },
    { injectedDate: "2026-10-11T00:00:00Z" }, { taskDate: null }, { extra: "body" }
  ]) {
    assert.throws(() => parseGrokBrokerProviderClockObservation({ ...providerClock, ...changed }), /invalid broker frame/u);
  }
});
