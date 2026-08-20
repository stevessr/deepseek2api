import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetRegistry,
  findSessionByPrefix,
  forgetSession,
  getSession,
  rememberSession
} from "../src/services/continue-service.js";

test.afterEach(() => {
  _resetRegistry();
});

test("rememberSession stores a session retrievable by response id", () => {
  const responseId = rememberSession({
    ownerId: "owner-1",
    sessionId: "session-abc",
    accountId: "account-1",
    modelType: "chat",
    prefix: "The quick brown fox"
  });

  const session = getSession("owner-1", responseId);
  assert.equal(session.sessionId, "session-abc");
  assert.equal(session.accountId, "account-1");
  assert.equal(session.modelType, "chat");
  assert.equal(session.prefix, "The quick brown fox");
});

test("getSession is scoped per owner and returns null for unknown ids", () => {
  const responseId = rememberSession({
    ownerId: "owner-1",
    sessionId: "s1",
    accountId: "a1",
    modelType: "chat"
  });

  assert.equal(getSession("owner-2", responseId), null);
  assert.equal(getSession("owner-1", "resp_missing"), null);
});

test("findSessionByPrefix matches a stored prefix at the start of a user message", () => {
  rememberSession({
    ownerId: "owner-1",
    sessionId: "s1",
    accountId: "a1",
    modelType: "chat",
    prefix: "The quick brown fox"
  });

  const match = findSessionByPrefix("owner-1", "The quick brown fox jumps over the lazy dog");
  assert.equal(match.session.sessionId, "s1");
});

test("findSessionByPrefix matches when the user message is a my-prefix of the stored text", () => {
  rememberSession({
    ownerId: "owner-1",
    sessionId: "s1",
    accountId: "a1",
    modelType: "chat",
    prefix: "The quick brown fox jumps"
  });

  const match = findSessionByPrefix("owner-1", "The quick brown fox");
  assert.equal(match.session.sessionId, "s1");
});

test("findSessionByPrefix prefers the longest matching prefix", () => {
  rememberSession({
    ownerId: "owner-1",
    sessionId: "s1",
    accountId: "a1",
    modelType: "chat",
    prefix: "The quick"
  });
  rememberSession({
    ownerId: "owner-1",
    sessionId: "s2",
    accountId: "a2",
    modelType: "chat",
    prefix: "The quick brown"
  });

  // "brown" is longer than "quick", so s2 wins
  const match = findSessionByPrefix("owner-1", "The quick brown fox");
  assert.equal(match.session.sessionId, "s2");
});

test("findSessionByPrefix returns null when nothing matches", () => {
  rememberSession({
    ownerId: "owner-1",
    sessionId: "s1",
    accountId: "a1",
    modelType: "chat",
    prefix: "The quick brown fox"
  });

  assert.equal(findSessionByPrefix("owner-1", "Completely different text"), null);
  assert.equal(findSessionByPrefix("owner-1", ""), null);
  assert.equal(findSessionByPrefix("owner-2", "The quick brown fox"), null);
});

test("forgetSession removes a session from lookup", () => {
  const responseId = rememberSession({
    ownerId: "owner-1",
    sessionId: "s1",
    accountId: "a1",
    modelType: "chat",
    prefix: "The quick"
  });

  forgetSession("owner-1", responseId);
  assert.equal(getSession("owner-1", responseId), null);
  assert.equal(findSessionByPrefix("owner-1", "The quick brown"), null);
});