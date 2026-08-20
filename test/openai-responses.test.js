import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponsesPayload,
  convertInputToMessages
} from "../src/services/openai-responses.js";

test("convertInputToMessages maps a string input to a single user message", () => {
  assert.deepEqual(convertInputToMessages("Hello"), [{ role: "user", content: "Hello" }]);
});

test("convertInputToMessages preserves user/assistant/system roles", () => {
  const messages = convertInputToMessages([
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" }
  ]);

  assert.deepEqual(messages, [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" }
  ]);
});

test("convertInputToMessages maps developer role to system", () => {
  const messages = convertInputToMessages([{ role: "developer", content: "Be concise." }]);
  assert.deepEqual(messages, [{ role: "system", content: "Be concise." }]);
});

test("convertInputToMessages maps function_call_output to tool role", () => {
  const messages = convertInputToMessages([
    { type: "function_call_output", call_id: "call_1", output: "42" }
  ]);

  assert.deepEqual(messages, [
    { role: "tool", content: "42", tool_call_id: "call_1" }
  ]);
});

test("convertInputToMessages drops unknown items and non-arrays gracefully", () => {
  assert.deepEqual(convertInputToMessages(null), []);
  assert.deepEqual(convertInputToMessages(undefined), []);
  assert.deepEqual(convertInputToMessages({ not: "an array" }), []);
  assert.deepEqual(convertInputToMessages([{ type: "unknown", foo: 1 }, null, 123]), []);
});

test("buildResponsesPayload emits an OpenAI Responses-shaped payload", () => {
  const payload = buildResponsesPayload("resp_1", "deepseek-chat", "Hello world", []);

  assert.equal(payload.id, "resp_1");
  assert.equal(payload.object, "response");
  assert.equal(payload.status, "completed");
  assert.equal(payload.model, "deepseek-chat");
  assert.equal(payload.output_text, "Hello world");
  assert.equal(payload.output.length, 1);
  assert.equal(payload.output[0].type, "message");
  assert.equal(payload.output[0].role, "assistant");
  assert.equal(payload.output[0].content[0].type, "output_text");
  assert.equal(payload.output[0].content[0].text, "Hello world");
  assert.deepEqual(payload.output[0].content[0].annotations, []);
});

test("buildResponsesPayload appends function_call items for tool calls", () => {
  const toolCalls = [
    { id: "call_1", function: { name: "weather", arguments: "{\"city\":\"sh\"}" } }
  ];
  const payload = buildResponsesPayload("resp_1", "deepseek-chat", "", toolCalls);

  const fnCall = payload.output[1];
  assert.equal(fnCall.type, "function_call");
  assert.equal(fnCall.name, "weather");
  assert.equal(fnCall.call_id, "call_1");
});

test("buildResponsesPayload omits output_text when content is empty", () => {
  const payload = buildResponsesPayload("resp_1", "deepseek-chat", "", []);
  assert.equal("output_text" in payload, false);
});