// In-memory session registry for the "会话前缀匹配继续" (session prefix-match continue) feature.
//
// Each completed OpenAI request stores a mapping from its response id to the
// DeepSeek chat_session_id and account that produced it.  A follow-up request
// carrying a `previous_response_id` (Responses API) or a custom `continue_from`
// field can reuse the same session and call `/chat/continue` to extend the
// last assistant response rather than starting a fresh session.
//
// Prefix matching: the registry also stores the trailing content of the
// assistant output.  When a new request's leading user message matches this
// prefix, the session is automatically continued (coherent continuation).

import { randomUUID } from "node:crypto";

import { getAccountById } from "./account-service.js";

const SESSION_TTL_MS = 30 * 60 * 1_000; // 30 minutes

// Map<ownerId, Map<responseId, SessionInfo>>
const registry = new Map();

const cleanupTimers = new Map();

/**
 * @typedef {Object} SessionInfo
 * @property {string} sessionId
 * @property {string} accountId
 * @property {string} modelType
 * @property {string} [prefix] - trailing content of the last assistant output
 * @property {number} createdAt
 */

function ensureOwnerMap(ownerId) {
  let ownerMap = registry.get(ownerId);
  if (!ownerMap) {
    ownerMap = new Map();
    registry.set(ownerId, ownerMap);
  }
  return ownerMap;
}

/**
 * Register a completed session for future continuation.
 *
 * @param {Object} options
 * @param {string} options.ownerId
 * @param {string} options.sessionId DeepSeek chat_session_id
 * @param {string} options.accountId
 * @param {string} options.modelType
 * @param {string} [options.prefix] trailing content of the assistant output (for prefix matching)
 * @returns {string} auto-generated responseId
 */
export function rememberSession({ ownerId, sessionId, accountId, modelType, prefix = "" }) {
  const responseId = `resp_${randomUUID()}`;
  const ownerMap = ensureOwnerMap(ownerId);

  const info = {
    sessionId,
    accountId,
    modelType,
    prefix: prefix.trimEnd(),
    createdAt: Date.now()
  };

  ownerMap.set(responseId, info);

  // Auto-cleanup after TTL
  clearTimeout(cleanupTimers.get(responseId));

  cleanupTimers.set(responseId, setTimeout(() => {
    forgetSession(ownerId, responseId);
  }, SESSION_TTL_MS));

  return responseId;
}

/**
 * Look up a session by its response id.
 * @param {string} ownerId
 * @param {string} responseId
 * @returns {SessionInfo | null}
 */
export function getSession(ownerId, responseId) {
  const ownerMap = registry.get(ownerId);
  if (!ownerMap) return null;
  return ownerMap.get(responseId) ?? null;
}

/**
 * Given a user message prefix, find the best-matching session for the owner.
 * Matches if the stored prefix is a non-empty string that is a prefix of the
 * given user message (or matches exactly).
 *
 * @param {string} ownerId
 * @param {string} userMessage
 * @returns {{ responseId: string, session: SessionInfo } | null}
 */
export function findSessionByPrefix(ownerId, userMessage) {
  const ownerMap = registry.get(ownerId);
  if (!ownerMap || !userMessage) return null;

  const trimmed = userMessage.trim();
  let bestMatch = null;
  let bestLength = -1;

  for (const [responseId, session] of ownerMap) {
    const sp = session.prefix;
    if (!sp) continue;

    // Check if sp is a prefix of the user message, or the user message starts with sp
    if (trimmed.startsWith(sp) || sp.startsWith(trimmed)) {
      // Prefer the longest match (more specific)
      if (sp.length > bestLength || (sp.length === bestLength && session.createdAt > (bestMatch?.session.createdAt ?? 0))) {
        bestMatch = { responseId, session };
        bestLength = sp.length;
      }
    }
  }

  return bestMatch;
}

/**
 * Remove a session from the registry.
 * @param {string} ownerId
 * @param {string} responseId
 */
export function forgetSession(ownerId, responseId) {
  const ownerMap = registry.get(ownerId);
  if (!ownerMap) return;

  ownerMap.delete(responseId);
  const timer = cleanupTimers.get(responseId);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(responseId);
  }

  if (ownerMap.size === 0) {
    registry.delete(ownerId);
  }
}

/**
 * Clean up all sessions for a given owner (e.g. on logout).
 * @param {string} ownerId
 */
export function forgetAllSessions(ownerId) {
  const ownerMap = registry.get(ownerId);
  if (!ownerMap) return;

  for (const [responseId] of ownerMap) {
    const timer = cleanupTimers.get(responseId);
    if (timer) {
      clearTimeout(timer);
      cleanupTimers.delete(responseId);
    }
  }

  registry.delete(ownerId);
}

/**
 * For testing: clear the entire registry.
 */
export function _resetRegistry() {
  for (const timers of cleanupTimers.values()) {
    clearTimeout(timers);
  }
  cleanupTimers.clear();
  registry.clear();
}

/**
 * Resolve the session to continue for a request.
 *
 * Priority:
 *  1. `previous_response_id` / `continue_from` references a remembered response.
 *  2. Prefix matching: if the leading user message matches the stored prefix of
 *     a prior session, that session is continued.
 *
 * @returns {{ sessionId: string, accountId: string, modelType: string } | { missingResponseId: string } | null}
 */
export function resolveContinueSession(ownerId, body) {
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
export function pickAccountWithContinue(continueSession, fallbackAccount) {
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