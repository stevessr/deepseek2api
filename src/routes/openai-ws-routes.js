// WebSocket upgrade handling for OpenAI-compatible endpoints.
//
// Currently exposes /v1/responses/ws: a persistent socket that carries a full
// Responses API conversation (see services/responses-ws-service.js).

import { getApiKeyRecord } from "../services/api-key-service.js";
import { attachResponsesWsConnection } from "../services/responses-ws-service.js";
import { acceptWebSocketUpgrade } from "../utils/websocket.js";

function isResponsesWsPath(pathname) {
  return pathname === "/v1/responses/ws" || pathname === "/v1/responses/ws/";
}

/**
 * Browsers cannot set an Authorization header on WebSocket connections, so
 * the key may also arrive as an `api_key` (or `key`) query parameter.
 */
function extractApiKey(request, url) {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return url.searchParams.get("api_key") ?? url.searchParams.get("key");
}

function rejectUpgrade(socket, statusCode, reasonPhrase, message) {
  if (socket.destroyed || socket.writableEnded) return;
  socket.write(
    `HTTP/1.1 ${statusCode} ${reasonPhrase}\r\n` +
      "connection: close\r\n" +
      "content-type: application/json\r\n" +
      "\r\n" +
      JSON.stringify({ error: message })
  );
  socket.destroy();
}

/**
 * Handle an HTTP upgrade request.
 * @returns {boolean} true when the request was handled (accepted or rejected)
 */
export function handleOpenAiUpgrade(request, socket, head) {
  let url;
  try {
    url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  } catch {
    rejectUpgrade(socket, 400, "Bad Request", "Invalid request URL");
    return true;
  }

  if (!isResponsesWsPath(url.pathname)) {
    return false;
  }

  const apiKey = extractApiKey(request, url);
  const apiKeyRecord = apiKey ? getApiKeyRecord(apiKey) : null;
  if (!apiKeyRecord) {
    rejectUpgrade(socket, 401, "Unauthorized", "Invalid API key");
    return true;
  }

  try {
    const connection = acceptWebSocketUpgrade(request, socket, head);
    attachResponsesWsConnection({ connection, apiKeyRecord });
  } catch {
    socket.destroy();
  }
  return true;
}
