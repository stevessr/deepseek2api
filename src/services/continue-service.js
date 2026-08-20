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