import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseClientMessage } from "../src/services/responses-ws-service.js";

test("parseClientMessage wraps response.create envelopes", () => {
  const parsed = parseClientMessage(JSON.stringify({ type: "response.create", response: { model: "deepseek-chat", input: "hi" } }));
  assert.equal(parsed.kind, "request");
  assert.equal(parsed.body.model, "deepseek-chat");
});

test("parseClientMessage accepts bare request bodies", () => {
  const parsed = parseClientMessage(JSON.stringify({ model: "deepseek-chat", input: "hi" }));
  assert.equal(parsed.kind, "request");
  assert.equal(parsed.body.input, "hi");
});

test("parseClientMessage classifies control messages", () => {
  assert.equal(parseClientMessage(JSON.stringify({ type: "ping" })).kind, "ping");
  assert.equal(parseClientMessage(JSON.stringify({ type: "pong" })).kind, "pong");
  assert.equal(parseClientMessage(JSON.stringify({ type: "conversation.new" })).kind, "conversation.new");
});

test("parseClientMessage flags malformed input", () => {
  assert.equal(parseClientMessage("not json").kind, "invalid_json");
  assert.equal(parseClientMessage(JSON.stringify([1, 2, 3])).kind, "invalid_message");
  assert.equal(parseClientMessage(JSON.stringify({ type: "response.create" })).kind, "invalid_message");
  assert.equal(parseClientMessage(JSON.stringify({ type: "mystery" })).kind, "unknown_type");
});

/**
 * Drive the full per-connection state machine in a throwaway store so account
 * and API-key lookups resolve against seeded fixtures rather than the real
 * data directory. Response runners are replaced with in-process stubs so no
 * upstream call is made.
 */
function runScenario(buildScript) {
  const directory = mkdtempSync(join(tmpdir(), "deepseek2api-ws-service-"));
  const harness = [
    `const ws = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "services", "responses-ws-service.js")).href)});`,
    `const store = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "storage", "store.js")).href)});`,
    `store.updateStore((state) => ({ ...state, accounts: [...state.accounts, { id: "acc-1", token: "t", ownerId: "admin" }] }));`,
    `const accountStub = { id: "acc-1", token: "t" };`,
    buildScript
  ].join("\n");

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", harness], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env }
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("WS conversation continues across turns without resending history", () => {
  const scenario = `
    const calls = [];
    const apiKeyRecord = { id: "key-1", ownerId: "admin", toolCallsEnabled: false };
    const deps = {
      collectResponsesResponse: async (args) => {
        calls.push(args);
        return { payload: { id: "resp_1" }, responseId: "resp_1", usedSessionId: "sess_1", modelType: "chat" };
      },
      streamResponsesResponse: async () => ({ responseId: "resp_1", usedSessionId: "sess_1", modelType: "chat" })
    };
    const sent = [];
    const connection = { send: (text) => { sent.push(JSON.parse(text)); return true; } };
    ws.attachResponsesWsConnection({ connection, apiKeyRecord, deps });

    await connection.handleMessage(JSON.stringify({ type: "ping" }));
    await connection.handleMessage(JSON.stringify({ model: "deepseek-chat", input: "hello" }));
    await connection.handleMessage(JSON.stringify({ model: "deepseek-chat", input: "more" }));
    await connection.handleMessage(JSON.stringify({ type: "conversation.new" }));
    await connection.handleMessage(JSON.stringify({ model: "deepseek-chat", input: "fresh" }));

    console.log(JSON.stringify({
      pongs: sent.filter((m) => m.type === "pong").length,
      completed: sent.filter((m) => m.type === "response.completed").map((m) => m.response.id),
      continueSessionIds: calls.map((c) => c.continueSessionId)
    }));`;

  const { pongs, completed, continueSessionIds } = runScenario(scenario);
  assert.equal(pongs, 1);
  assert.deepEqual(completed, ["resp_1", "resp_1", "resp_1"]);
  assert.deepEqual(continueSessionIds, [null, "sess_1", null]);
});

test("explicit previous_response_id overrides the conversation memory", () => {
  const scenario = `
    const calls = [];
    const apiKeyRecord = { id: "key-1", ownerId: "admin", toolCallsEnabled: false };
    const deps = {
      collectResponsesResponse: async (args) => {
        calls.push(args);
        return { payload: { id: "resp_2" }, responseId: "resp_2", usedSessionId: "sess_2", modelType: "chat" };
      }
    };
    const sent = [];
    const connection = { send: (text) => { sent.push(JSON.parse(text)); return true; } };
    ws.attachResponsesWsConnection({ connection, apiKeyRecord, deps });

    await connection.handleMessage(JSON.stringify({ model: "deepseek-chat", input: "hello" }));
    await connection.handleMessage(JSON.stringify({ model: "deepseek-chat", input: "x", previous_response_id: "missing_id" }));

    const errors = sent.filter((m) => m.type === "error");
    console.log(JSON.stringify({ errorCount: errors.length, codes: errors.map((e) => e.code), statuses: errors.map((e) => e.status) }));`;

  const { errorCount, codes, statuses } = runScenario(scenario);
  assert.equal(errorCount, 1);
  assert.equal(codes[0], "not_found");
  assert.equal(statuses[0], 404);
});

test("stream turns forward Responses events as WebSocket messages", () => {
  const scenario = `
    const apiKeyRecord = { id: "key-1", ownerId: "admin", toolCallsEnabled: false };
    const deps = {
      streamResponsesResponse: async ({ transport }) => {
        transport.emit("response.created", { type: "response.created" });
        transport.emit("response.output_text.delta", { type: "response.output_text.delta", delta: "Hi" });
        transport.emit("response.completed", { type: "response.completed" });
        return { responseId: "resp_3", usedSessionId: "sess_3", modelType: "chat" };
      }
    };
    const sent = [];
    const connection = { send: (text) => { sent.push(JSON.parse(text)); return true; } };
    ws.attachResponsesWsConnection({ connection, apiKeyRecord, deps });
    await connection.handleMessage(JSON.stringify({ type: "response.create", response: { model: "deepseek-chat", input: "hi", stream: true } }));
    console.log(JSON.stringify({ types: sent.map((m) => m.type) }));`;

  const { types } = runScenario(scenario);
  assert.deepEqual(types, ["response.created", "response.output_text.delta", "response.completed"]);
});

test("a second turn while one is in flight is rejected as busy", () => {
  const scenario = `
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const apiKeyRecord = { id: "key-1", ownerId: "admin", toolCallsEnabled: false };
    const deps = {
      collectResponsesResponse: async () => {
        await gate;
        return { payload: { id: "resp_4" }, responseId: "resp_4", usedSessionId: "sess_4", modelType: "chat" };
      }
    };
    const sent = [];
    const connection = { send: (text) => { sent.push(JSON.parse(text)); return true; } };
    ws.attachResponsesWsConnection({ connection, apiKeyRecord, deps });

    const pending = connection.handleMessage(JSON.stringify({ model: "deepseek-chat", input: "slow" }));
    await Promise.resolve();
    connection.handleMessage(JSON.stringify({ model: "deepseek-chat", input: "too fast" }));
    await Promise.resolve();
    release();
    await pending;

    const busy = sent.filter((m) => m.type === "error" && m.code === "busy");
    const completed = sent.filter((m) => m.type === "response.completed");
    console.log(JSON.stringify({ busyCount: busy.length, busyStatus: busy[0]?.status, completedCount: completed.length }));`;

  const { busyCount, busyStatus, completedCount } = runScenario(scenario);
  assert.equal(busyCount, 1);
  assert.equal(busyStatus, 409);
  assert.equal(completedCount, 1);
});
