// OpenAI Responses API (/v1/responses) compatibility layer.
//
// Maps between the OpenAI Responses API format and the internal chat
// completion flow, reusing resolveCompletionRequest / collectCompletionContent
// / streamCompletionContent.
//
// Supported features:
//  - Non-streaming (collect) and streaming (SSE or custom transport, e.g. WebSocket) responses
//  - `input` (array of roles / function_call_output / string) -> messages
//  - `instructions` -> prepended system message
//  - `previous_response_id` -> session continue via continue-service
//  - Tool calls (via existing tool-sieve)

import { randomUUID } from "node:crypto";

import { resolveCompletionRequest } from "./openai-bridge.js";
import { collectCompletionContent, streamCompletionContent } from "./openai-completion-runner.js";
import { createToolSieve, extractToolAwareOutput } from "./openai-tool-sieve.js";
import { rememberSession } from "./continue-service.js";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createResponseId() {
  return `resp_${randomUUID()}`;
}

function createMessageId() {
  return `msg_${randomUUID()}`;
}

/**
 * Convert Responses API "input" to the internal messages array.
 *
 * Input can be:
 *  - A string (single user message)
 *  - An array of {role, content} objects
 *  - An array with {type: "function_call_output", call_id, output} items
 *  - An array with {type: "message", role, content} items
 */
export function convertInputToMessages(input) {
  if (!input) return [];

  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) return [];

  return input
    .filter(Boolean)
    .flatMap((item) => {
      if (typeof item === "string") {
        return [{ role: "user", content: item }];
      }

      if (item.role === "user" || item.role === "assistant" || item.role === "system" || item.role === "developer") {
        return { role: item.role === "developer" ? "system" : item.role, content: item.content };
      }

      if (item.type === "function_call_output") {
        return { role: "tool", content: item.output, tool_call_id: item.call_id ?? "" };
      }

      if (item.type === "message" && item.role) {
        return { role: item.role, content: item.content };
      }

      return [];
    });
}

// --------------------------------------------------------------------------
// Response payload builders
// --------------------------------------------------------------------------

export function buildResponsesPayload(responseId, modelId, content, toolCalls) {
  const output = [];
  const msgId = createMessageId();

  output.push({
    id: msgId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: content ?? "",
        annotations: []
      }
    ]
  });

  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      output.push({
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments
      });
    }
  }

  const payload = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: modelId,
    output
  };

  if (content) {
    payload.output_text = content;
  }

  return payload;
}

// --------------------------------------------------------------------------
// SSE helpers (Responses API event format)
// --------------------------------------------------------------------------

function writeSseEvent(response, eventName, data) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Transport adapter for streamResponsesResponse. The default transport writes
 * Responses API events as an HTTP SSE body; WebSocket callers supply their own
 * { start, emit, end } implementation.
 */
function createSseTransport(response) {
  return {
    start() {
      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      response.flushHeaders?.();
    },
    emit(eventName, data) {
      writeSseEvent(response, eventName, data);
    },
    end() {
      response.end();
    }
  };
}

function createResponseCreatedEvent(responseId, modelId) {
  return {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model: modelId,
      output: [],
      output_text: ""
    }
  };
}

function createResponseInProgressEvent(responseId, modelId) {
  return {
    type: "response.in_progress",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model: modelId
    }
  };
}

function createOutputItemAddedEvent(responseId, msgId, outputIndex) {
  return {
    type: "response.output_item.added",
    item: {
      id: msgId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: []
    },
    response_id: responseId,
    output_index: outputIndex
  };
}

function createContentPartAddedEvent(responseId, outputIndex, contentIndex) {
  return {
    type: "response.content_part.added",
    part: {
      type: "output_text",
      text: "",
      annotations: []
    },
    response_id: responseId,
    output_index: outputIndex,
    content_index: contentIndex
  };
}

function createOutputTextDeltaEvent(responseId, delta, outputIndex, contentIndex) {
  return {
    type: "response.output_text.delta",
    delta,
    response_id: responseId,
    output_index: outputIndex,
    content_index: contentIndex
  };
}

function createOutputTextDoneEvent(responseId, text, outputIndex, contentIndex) {
  return {
    type: "response.output_text.done",
    text,
    response_id: responseId,
    output_index: outputIndex,
    content_index: contentIndex
  };
}

function createContentPartDoneEvent(responseId, text, outputIndex, contentIndex) {
  return {
    type: "response.content_part.done",
    part: {
      type: "output_text",
      text,
      annotations: []
    },
    response_id: responseId,
    output_index: outputIndex,
    content_index: contentIndex
  };
}

function createOutputItemDoneEvent(responseId, msgId, text, outputIndex) {
  return {
    type: "response.output_item.done",
    item: {
      id: msgId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    },
    response_id: responseId,
    output_index: outputIndex
  };
}

function createResponseCompletedEvent(responseId, modelId, text, msgId) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: modelId,
      output: [
        {
          id: msgId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }]
        }
      ],
      output_text: text
    }
  };
}

function createResponseFailedEvent(responseId, modelId, error) {
  return {
    type: "response.failed",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      model: modelId,
      error: { code: "server_error", message: error.message }
    }
  };
}

// --------------------------------------------------------------------------
// Internal request builder
// --------------------------------------------------------------------------

/**
 * Convert a Responses API request body into the internal chat-completion body
 * that resolveCompletionRequest can consume.
 */
function toInternalBody(body) {
  const messages = convertInputToMessages(body.input);

  if (body.instructions && typeof body.instructions === "string") {
    messages.unshift({ role: "system", content: body.instructions });
  }

  return {
    model: body.model,
    messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
    stream: false,
    ref_file_ids: body.ref_file_ids
  };
}

// --------------------------------------------------------------------------
// Non-streaming response
// --------------------------------------------------------------------------

export async function collectResponsesResponse({
  account,
  body,
  continueSessionId = null,
  deleteAfterFinish = false,
  ownerId,
  toolCallsEnabled = false
}) {
  const internalBody = toInternalBody(body);
  const requestOptions = resolveCompletionRequest({ body: internalBody, ownerId, toolCallsEnabled });

  const { content, sessionId: usedSessionId } = await collectCompletionContent({
    account,
    continueSessionId,
    deleteAfterFinish,
    requestOptions
  });

  const parsed = requestOptions.toolNames.length
    ? extractToolAwareOutput(content, requestOptions.toolNames)
    : { content, toolCalls: [] };

  const responseId = createResponseId();
  const payload = buildResponsesPayload(
    responseId,
    requestOptions.model.id,
    parsed.content,
    parsed.toolCalls
  );

  // Register the session for future continuation (unless incognito)
  if (!deleteAfterFinish && usedSessionId) {
    rememberSession({
      ownerId,
      sessionId: usedSessionId,
      accountId: account.id,
      modelType: requestOptions.model.modelType,
      prefix: content?.trimEnd?.() ?? ""
    });
  }

  return { payload, responseId, usedSessionId, modelType: requestOptions.model.modelType };
}

// --------------------------------------------------------------------------
// Streaming response (SSE)
// --------------------------------------------------------------------------

export async function streamResponsesResponse(options) {
  const {
    account,
    body,
    continueSessionId = null,
    deleteAfterFinish = false,
    ownerId,
    response,
    toolCallsEnabled = false,
    // Optional transport override ({ start, emit, end }); defaults to SSE.
    transport: transportOverride
  } = options;

  const internalBody = toInternalBody(body);
  const responseId = createResponseId();
  const msgId = createMessageId();
  const requestOptions = resolveCompletionRequest({ body: internalBody, ownerId, toolCallsEnabled });

  const toolSieve = requestOptions.toolNames.length
    ? createToolSieve(requestOptions.toolNames)
    : null;

  let sawToolCall = false;
  let accumulatedText = "";

  const transport = transportOverride ?? createSseTransport(response);
  transport.start();

  const emitEvent = (eventName, data) => transport.emit(eventName, data);

  // Phase 1: response.created
  emitEvent("response.created", createResponseCreatedEvent(responseId, requestOptions.model.id));

  // Phase 2: response.in_progress
  emitEvent("response.in_progress", createResponseInProgressEvent(responseId, requestOptions.model.id));

  // Phase 3: output item added (message wrapper)
  emitEvent("response.output_item.added", createOutputItemAddedEvent(responseId, msgId, 0));

  // Phase 4: content part added (text part)
  emitEvent("response.content_part.added", createContentPartAddedEvent(responseId, 0, 0));

  // Phase 5: stream content
  let usedSessionId = null;
  try {
    ({ sessionId: usedSessionId } = await streamCompletionContent({
      account,
      continueSessionId,
      deleteAfterFinish,
      onText: (delta) => {
        if (!toolSieve) {
          accumulatedText += delta;
          emitEvent("response.output_text.delta", createOutputTextDeltaEvent(responseId, delta, 0, 0));
          return;
        }

        const events = toolSieve.push(delta);
        for (const event of events) {
          if (event.type === "tool_calls") {
            sawToolCall = true;
            // Tool calls are emitted as output_text.delta for now
            // (full function_call items could be added later)
            continue;
          }

          if (event.text) {
            accumulatedText += event.text;
            emitEvent("response.output_text.delta", createOutputTextDeltaEvent(responseId, event.text, 0, 0));
          }
        }
      },
      requestOptions
    }));
    if (toolSieve) {
      const tailEvents = toolSieve.flush();
      for (const event of tailEvents) {
        if (event.text) {
          accumulatedText += event.text;
          emitEvent("response.output_text.delta", createOutputTextDeltaEvent(responseId, event.text, 0, 0));
        }
      }
    }
  } catch (error) {
    emitEvent("response.failed", createResponseFailedEvent(responseId, requestOptions.model.id, error));
    transport.end();
    return { responseId, usedSessionId: null, modelType: requestOptions.model.modelType };
  }

  // Phase 6: output_text.done
  emitEvent("response.output_text.done", createOutputTextDoneEvent(responseId, accumulatedText, 0, 0));

  // Phase 7: content_part.done
  emitEvent("response.content_part.done", createContentPartDoneEvent(responseId, accumulatedText, 0, 0));

  // Phase 8: output_item.done
  emitEvent("response.output_item.done", createOutputItemDoneEvent(responseId, msgId, accumulatedText, 0));

  // Phase 9: response.completed
  emitEvent("response.completed", createResponseCompletedEvent(responseId, requestOptions.model.id, accumulatedText, msgId));

  transport.end();

  // Register session for future continuation (unless incognito)
  if (!deleteAfterFinish && usedSessionId) {
    rememberSession({
      ownerId,
      sessionId: usedSessionId,
      accountId: account.id,
      modelType: requestOptions.model.modelType,
      prefix: accumulatedText.trimEnd()
    });
  }

  return { responseId, usedSessionId, modelType: requestOptions.model.modelType };
}