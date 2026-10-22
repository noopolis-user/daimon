import assert from "node:assert/strict";
import test from "node:test";
import { parseGrokBrokerProxyJson } from "./grokBrokerProxyJson.js";

test("unambiguous JSON preserves exact bytes, even string escapes, colons, and number spellings", () => {
  for (const text of [
    ' { "messages" : [{ "role": "user", "content": "\\"key\\": value" }] }\n',
    '{"empty":{},"array":[{"key":1},{"key":2}],"escaped":"\\u0061","number":1e2}',
    '{"": {"": "colon: and braces { }"}, "slashes": "\\\\\\\""}'
  ]) {
    const body = Buffer.from(text);
    const parsed = parseGrokBrokerProxyJson(body);
    assert.deepEqual(parsed.value, JSON.parse(text));
    assert.deepEqual(parsed.body, body);
  }
});

test("all duplicate members normalize, including escaped keys and discarded nested objects", () => {
  for (const text of [
    '{"model":"unsafe","\\u006dodel":"safe"}',
    '{"key":{"discarded":true},"key":null}',
    '{"outer":[{"content":"first","content":"second"}]}'
  ]) {
    const parsed = parseGrokBrokerProxyJson(Buffer.from(text));
    assert.equal(Buffer.from(parsed.body).toString(), JSON.stringify(JSON.parse(text)));
  }
});

test("raw forwarding refuses invalid UTF-8 and prototype keys", () => {
  for (const body of [
    Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0x80]), Buffer.from('"}')]),
    Buffer.from('{"x":{"__proto__":{}}}')
  ]) assert.throws(() => parseGrokBrokerProxyJson(body));
});
