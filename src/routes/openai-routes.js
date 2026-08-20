import { getApiKeyRecord, recordApiKeyUsage } from "../services/api-key-service.js";
import { takeRoundRobinAccount } from "../services/account-rotation-service.js";
import { getAccountById } from "../services/account-service.js";
import { isIncognitoEnabledForOwner } from "../services/incognito-service.js";
import { collectOpenAiResponse, streamOpenAiResponse } from "../services/openai-bridge.js";
import { collectResponsesResponse, streamResponsesResponse } from "../services/openai-responses.js";
import { listOpenAiModels } from "../services/openai-request.js";
import { recordRequestLog } from "../services/request-log-service.js";
import { withOwnerRequestLimit } from "../services/request-limit-service.js";
import { getSession, findSessionByPrefix } from "../services/continue-service.js";
import { parseJsonBody, readRequestBody, sendError, sendJson } from "../utils/http.js";

function getBearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
  return match ? match[1].trim() : "";
}

function isModelsPath(pathname) {
  return pathname === "/models" || pathname === "/models/" ||
    pathname === "/v1/models" || pathname === "/v1/models/";
}

function isChatCompletionsPath(pathname) {
  return pathname === "/v1/chat/completions" || pathname === "/v1/chat/completions/";
}

function isResponsesPath(pathname) {
  return pathname === "/v1/responses" || pathname === "/v1/responses/";
}

function resolveLimitStatus(error) {
  return error.code === "USER_DISABLED" ? 403 : 429;
}

function handleOpenAiError(response, error) {
  if (error.code === "USER_DISABLED" || error.code === "REQUEST_LIMIT") {
    sendError(response, resolveLimitStatus(error), error.message);
    return true;
  }

  if (error instanceof SyntaxError) {
    sendError(response, 400, "Invalid JSON body");
    return true;
  }

  if (error.statusCode) {
    sendError(response, error.statusCode, error.message);
    return true;
  }

  return false;
}

async function handleModelsRequest(response, apiKeyRecord) {
  await withOwnerRequestLimit(apiKeyRecord.ownerId, async () => {
    sendJson(response, 200, {
      object: "list",
      data: listOpenAiModels()
    });
  });
}

/**
 * Resolve the session to continue for a request.
 *
 * Priority:
 *  1. `previous_response_id` / `continue_from` references a remembered response.
 *  2. Prefix matching: if the leading user message matches the stored prefix of
 *     a prior session, that session is continued.
 *
 * @returns {{ sessionId: string, accountId: string, modelType: string } | null}
 */
function resolveContinueSession(apiKeyRecord, body) {
  const ownerId = apiKeyRecord.ownerId;

  // 1. Explicit reference via previous_response_id (Responses API) or continue_from (custom)
  const previousResponseId = body?.previous_response_id ?? body?.continue_from;
  if (previousResponseId) {
    const session = getSession(ownerId, previousResponseId);
    if (session) {
      return {
        sessionId: session.sessionId,
        accountId: session.accountId,
        modelType: session.modelType
      };
    }
    return { missingResponseId: previousResponseId };
  }

  // 2. Prefix matching on the leading user message
  const input = body?.input ?? body?.messages;
  const messages = Array.isArray(input) ? input : [];
  const firstUserText = messages
    .map((message) => {
      if (typeof message === "string") return message;
      if (typeof message?.content === "string") return message.content;
      return "";
    })
    .find(Boolean);

  if (firstUserText) {
    const match = findSessionByPrefix(ownerId, firstUserText);
    if (match) {
      return {
        sessionId: match.session.sessionId,
        accountId: match.session.accountId,
        modelType: match.session.modelType
      };
    }
  }

  return null;
}

/**
 * Validate the resolved continue session and reconcile the account.
 * The session must run on the account that owns it (round-robin accounts
 * do not share sessions), so resolution prefers the remembered account.
 */
function pickAccountWithContinue(apiKeyRecord, continueSession, fallbackAccount) {
  if (!continueSession) {
    return { account: fallbackAccount, continueSessionId: null };
  }

  if (continueSession.missingResponseId) {
    const error = new Error(`Unknown response id: ${continueSession.missingResponseId}`);
    error.statusCode = 404;
    throw error;
  }

  // The fallback (round-robin) account may differ from the account that
  // created the session. Use the original account unless the round-robin
  // arrow already matches.
  const owningAccount = continueSession.accountId
    ? getAccountById(continueSession.accountId)
    : null;

  // If the session's account is no longer usable, fail closed rather than
  // silently continuing on a different (session-less) account.
  if (continueSession.accountId && !owningAccount) {
    const error = new Error("Session account is no longer available");
    error.statusCode = 404;
    throw error;
  }

  return {
    account: owningAccount ?? fallbackAccount,
    continueSessionId: continueSession.sessionId
  };
}

async function handleChatCompletionsRequest(request, response, apiKeyRecord) {
  await withOwnerRequestLimit(apiKeyRecord.ownerId, async () => {
    const startedAt = Date.now();
    const body = parseJsonBody(await readRequestBody(request)) ?? {};
    const account = takeRoundRobinAccount(apiKeyRecord);
    if (!account) {
      recordRequestLog({
        method: "POST",
        path: "/v1/chat/completions",
        model: body.model,
        ownerId: apiKeyRecord.ownerId,
        status: 404,
        durationMs: Date.now() - startedAt,
        error: "Account not found"
      });
      sendError(response, 404, "Account not found");
      return;
    }

    const deleteAfterFinish = isIncognitoEnabledForOwner(apiKeyRecord.ownerId);
    const continueSession = resolveContinueSession(apiKeyRecord, body);
    const { account: usedAccount, continueSessionId } = pickAccountWithContinue(apiKeyRecord, continueSession, account);

    try {
      const common = {
        account: usedAccount,
        body,
        continueSessionId,
        deleteAfterFinish,
        ownerId: apiKeyRecord.ownerId,
        toolCallsEnabled: apiKeyRecord.toolCallsEnabled
      };

      if (body.stream) {
        await streamOpenAiResponse({ ...common, response });
        recordRequestLog({
          method: "POST",
          path: "/v1/chat/completions",
          model: body.model,
          ownerId: apiKeyRecord.ownerId,
          accountId: usedAccount.id,
          status: 200,
          durationMs: Date.now() - startedAt
        });
        return;
      }

      const payload = await collectOpenAiResponse(common);
      sendJson(response, 200, payload);
      recordRequestLog({
        method: "POST",
        path: "/v1/chat/completions",
        model: body.model,
        ownerId: apiKeyRecord.ownerId,
        accountId: usedAccount.id,
        status: 200,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      recordRequestLog({
        method: "POST",
        path: "/v1/chat/completions",
        model: body.model,
        ownerId: apiKeyRecord.ownerId,
        accountId: usedAccount.id,
        status: error.statusCode ?? 500,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      throw error;
    }
  });
}

async function handleResponsesRequest(request, response, apiKeyRecord) {
  await withOwnerRequestLimit(apiKeyRecord.ownerId, async () => {
    const startedAt = Date.now();
    const body = parseJsonBody(await readRequestBody(request)) ?? {};
    const account = takeRoundRobinAccount(apiKeyRecord);
    if (!account) {
      recordRequestLog({
        method: "POST",
        path: "/v1/responses",
        model: body.model,
        ownerId: apiKeyRecord.ownerId,
        status: 404,
        durationMs: Date.now() - startedAt,
        error: "Account not found"
      });
      sendError(response, 404, "Account not found");
      return;
    }

    const deleteAfterFinish = isIncognitoEnabledForOwner(apiKeyRecord.ownerId);
    const continueSession = resolveContinueSession(apiKeyRecord, body);
    const { account: usedAccount, continueSessionId } = pickAccountWithContinue(apiKeyRecord, continueSession, account);

    try {
      const common = {
        account: usedAccount,
        body,
        continueSessionId,
        deleteAfterFinish,
        ownerId: apiKeyRecord.ownerId,
        toolCallsEnabled: apiKeyRecord.toolCallsEnabled
      };

      if (body.stream) {
        await streamResponsesResponse({ ...common, response });
        recordRequestLog({
          method: "POST",
          path: "/v1/responses",
          model: body.model,
          ownerId: apiKeyRecord.ownerId,
          accountId: usedAccount.id,
          status: 200,
          durationMs: Date.now() - startedAt
        });
        return;
      }

      const payload = await collectResponsesResponse(common);
      sendJson(response, 200, payload);
      recordRequestLog({
        method: "POST",
        path: "/v1/responses",
        model: body.model,
        ownerId: apiKeyRecord.ownerId,
        accountId: usedAccount.id,
        status: 200,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      recordRequestLog({
        method: "POST",
        path: "/v1/responses",
        model: body.model,
        ownerId: apiKeyRecord.ownerId,
        accountId: usedAccount.id,
        status: error.statusCode ?? 500,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      throw error;
    }
  });
}

export async function handleOpenAiRequest(request, response, url) {
  const apiKey = getBearerToken(request);
  const apiKeyRecord = apiKey ? getApiKeyRecord(apiKey) : null;

  if (!apiKeyRecord) {
    sendError(response, 401, "Invalid API key");
    return true;
  }

  try {
    if (request.method === "GET" && isModelsPath(url.pathname)) {
      recordApiKeyUsage(apiKeyRecord.id);
      await handleModelsRequest(response, apiKeyRecord);
      return true;
    }

    if (request.method === "POST" && isChatCompletionsPath(url.pathname)) {
      recordApiKeyUsage(apiKeyRecord.id);
      await handleChatCompletionsRequest(request, response, apiKeyRecord);
      return true;
    }

    if (request.method === "POST" && isResponsesPath(url.pathname)) {
      recordApiKeyUsage(apiKeyRecord.id);
      await handleResponsesRequest(request, response, apiKeyRecord);
      return true;
    }
  } catch (error) {
    if (!handleOpenAiError(response, error)) {
      throw error;
    }
    return true;
  }

  return false;
}