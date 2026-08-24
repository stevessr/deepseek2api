// WebSocket transport for the Responses API (/v1/responses/ws).
//
// One socket carries a whole conversation: each client message is a
// Responses API request, and the server streams the same Responses events it
// would send over SSE as individual JSON text messages. The connection
// remembers the DeepSeek session of the last turn, so follow-up messages
// automatically continue the same conversation without resending history.
//
// Client -> server (JSON text frames):
//   { "type": "response.create", "response": { model, input, stream, ... } }
//   { ...bare Responses request body... }          (lenient shorthand)
//   { "type": "conversation.new" }                 start a fresh conversation
//   { "type": "ping" }
//
// Server -> client:
//   Responses API events ({ type: "response.created" | "...delta" | "response.completed" | ... })
//   { "type": "response.completed", "response": { full payload } }  for non-stream turns
//   { "type": "conversation.new" }                 ack for the reset
//   { "type": "pong" }
//   { "type": "error", "code", "status", "message" }

import { takeRoundRobinAccount } from "./account-rotation-service.js";
import { pickAccountWithContinue, resolveContinueSession } from "./continue-service.js";
import { recordApiKeyUsage } from "./api-key-service.js";
import { isIncognitoEnabledForOwner } from "./incognito-service.js";
import { collectResponsesResponse, streamResponsesResponse } from "./openai-responses.js";
import { recordRequestLog } from "./request-log-service.js";
import { withOwnerRequestLimit } from "./request-limit-service.js";
import { redactSensitiveText } from "../utils/privacy.js";

const WS_LOG_PATH = "/v1/responses/ws";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Classify one incoming text frame.
 * @returns {{ kind: string, body?: object, typeName?: string }}
 */
export function parseClientMessage(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return { kind: "invalid_json" };
  }

  if (!isPlainObject(message)) {
    return { kind: "invalid_message" };
  }

  switch (message.type) {
    case "ping":
      return { kind: "ping" };
    case "pong":
      return { kind: "pong" };
    case "conversation.new":
      return { kind: "conversation.new" };
    case "response.create":
      return isPlainObject(message.response)
        ? { kind: "request", body: message.response }
        : { kind: "invalid_message" };
    case undefined:
    case null:
      break;
    default:
      return { kind: "unknown_type", typeName: String(message.type) };
  }

  return { kind: "request", body: message };
}

/**
 * Continuation resolution for a WS turn. Priority:
 *  1. explicit previous_response_id / continue_from (global registry)
 *  2. new_conversation === true -> fresh session
 *  3. the previous turn on this socket (works even under incognito, because
 *     nothing is persisted beyond the connection lifetime)
 *  4. prefix matching against remembered sessions (HTTP parity fallback)
 */
function resolveTurnContinue(ownerId, body, lastTurn) {
  const explicit = body?.previous_response_id ?? body?.continue_from;
  if (explicit) {
    return resolveContinueSession(ownerId, body);
  }
  if (body?.new_conversation === true) {
    return null;
  }
  if (lastTurn) {
    return {
      sessionId: lastTurn.sessionId,
      accountId: lastTurn.accountId,
      modelType: lastTurn.modelType
    };
  }
  return resolveContinueSession(ownerId, body);
}

function resolveErrorStatus(error) {
  if (error.code === "USER_DISABLED") return 403;
  if (error.code === "REQUEST_LIMIT") return 429;
  return error.statusCode ?? 500;
}

function errorCodeForStatus(status) {
  if (status === 400) return "bad_request";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "server_error";
}

function createWsTransport(connection) {
  return {
    start() {},
    emit(_eventName, data) {
      connection.send(JSON.stringify(data));
    },
    end() {}
  };
}

/**
 * Drive one connection. The caller owns the socket lifecycle; this only wires
 * per-connection protocol state (last-turn memory + single-flight guard).
 *
 * @param {object} options
 * @param {object} options.connection value returned by acceptWebSocketUpgrade
 * @param {object} options.apiKeyRecord authenticated API key record
 * @param {object} [options.deps] test seams for response runners
 */
export function attachResponsesWsConnection({ connection, apiKeyRecord, deps = {} }) {
  const impl = {
    collectResponsesResponse: deps.collectResponsesResponse ?? collectResponsesResponse,
    streamResponsesResponse: deps.streamResponsesResponse ?? streamResponsesResponse
  };

  let busy = false;
  let lastTurn = null; // { responseId, sessionId, accountId, modelType }

  const sendJson = (payload) => connection.send(JSON.stringify(payload));

  const sendErrorEvent = (code, status, message) => {
    sendJson({ type: "error", code, status, message });
  };

  async function executeTurn(body, startedAt) {
    const account = takeRoundRobinAccount(apiKeyRecord);
    if (!account) {
      const error = new Error("Account not found");
      error.statusCode = 404;
      throw error;
    }

    const deleteAfterFinish = isIncognitoEnabledForOwner(apiKeyRecord.ownerId);
    const continueSession = resolveTurnContinue(apiKeyRecord.ownerId, body, lastTurn);
    const { account: usedAccount, continueSessionId } = pickAccountWithContinue(continueSession, account);

    const common = {
      account: usedAccount,
      body,
      continueSessionId,
      deleteAfterFinish,
      ownerId: apiKeyRecord.ownerId,
      toolCallsEnabled: apiKeyRecord.toolCallsEnabled
    };

    let result;
    if (body.stream === true) {
      result = await impl.streamResponsesResponse({ ...common, transport: createWsTransport(connection) });
    } else {
      result = await impl.collectResponsesResponse(common);
      sendJson({ type: "response.completed", response: result.payload });
    }

    recordRequestLog({
      method: "POST",
      path: WS_LOG_PATH,
      model: body.model,
      ownerId: apiKeyRecord.ownerId,
      accountId: usedAccount.id,
      status: 200,
      durationMs: Date.now() - startedAt
    });

    // Track the conversation only when the upstream session survived
    // (deleteAfterFinish tears it down immediately).
    if (!deleteAfterFinish && result.usedSessionId) {
      lastTurn = {
        responseId: result.responseId,
        sessionId: result.usedSessionId,
        accountId: usedAccount.id,
        modelType: result.modelType
      };
    }
  }

  async function runTurn(body) {
    if (busy) {
      sendErrorEvent("busy", 409, "A response is already in progress on this connection");
      return;
    }

    busy = true;
    recordApiKeyUsage(apiKeyRecord.id);
    const startedAt = Date.now();

    try {
      await withOwnerRequestLimit(apiKeyRecord.ownerId, () => executeTurn(body, startedAt));
    } catch (error) {
      const status = resolveErrorStatus(error);
      const message = redactSensitiveText(error.message ?? "Internal error");
      recordRequestLog({
        method: "POST",
        path: WS_LOG_PATH,
        model: body.model,
        ownerId: apiKeyRecord.ownerId,
        status,
        durationMs: Date.now() - startedAt,
        error: message
      });
      sendErrorEvent(errorCodeForStatus(status), status, message);
    } finally {
      busy = false;
    }
  }

  connection.handleMessage = (text) => {
    const parsed = parseClientMessage(text);

    switch (parsed.kind) {
      case "ping":
        sendJson({ type: "pong" });
        return;
      case "pong":
        return;
      case "conversation.new":
        lastTurn = null;
        sendJson({ type: "conversation.new" });
        return;
      case "request":
        return runTurn(parsed.body);
      case "invalid_json":
        sendErrorEvent("bad_request", 400, "Message is not valid JSON");
        return;
      case "invalid_message":
        sendErrorEvent("bad_request", 400, 'Expected a request object or {"type":"response.create","response":{...}}');
        return;
      default:
        sendErrorEvent("bad_request", 400, `Unknown message type: ${parsed.typeName}`);
    }
  };
}
