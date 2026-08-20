import { createDeepseekDeltaDecoder, createSseParser } from "../utils/deepseek-sse.js";
import { createChatSession, deleteChatSession } from "./chat-session-service.js";
import { uploadOpenAiVisionFiles } from "./deepseek-file-service.js";
import { proxyDeepseekRequest } from "./deepseek-proxy.js";

const THINK_OPEN_TAG = " \u003cthinking";
const THINK_CLOSE_TAG = " \u003c/thinking\u003e\n\n";

/**
 * Start a new chat completion in a session.
 */
function startCompletion({ account, requestOptions, sessionId }) {
  return proxyDeepseekRequest({
    account,
    method: "POST",
    path: "/chat/completion",
    body: Buffer.from(
      JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: requestOptions.model.modelType,
        prompt: requestOptions.prompt,
        ref_file_ids: requestOptions.refFileIds ?? [],
        thinking_enabled: requestOptions.model.thinkingEnabled,
        search_enabled: requestOptions.model.searchEnabled,
        action: null,
        preempt: false
      })
    ),
    headers: { "content-type": "application/json" }
  });
}

/**
 * Continue the last assistant response in an existing session.
 * Uses the DeepSeek /chat/continue endpoint to extend the last response.
 */
function continueCompletion({ account, requestOptions, sessionId }) {
  return proxyDeepseekRequest({
    account,
    method: "POST",
    path: "/chat/continue",
    body: Buffer.from(
      JSON.stringify({
        chat_session_id: sessionId,
        model_type: requestOptions.model.modelType,
        thinking_enabled: requestOptions.model.thinkingEnabled,
        search_enabled: requestOptions.model.searchEnabled,
        preempt: false
      })
    ),
    headers: { "content-type": "application/json" }
  });
}

async function prepareRequestOptions({ account, requestOptions, sessionId }) {
  if (!requestOptions.imageInputs?.length) {
    return { ...requestOptions, refFileIds: requestOptions.refFileIds ?? [] };
  }

  const refFileIds = await uploadOpenAiVisionFiles({
    account,
    imageInputs: requestOptions.imageInputs,
    sessionId
  });

  return {
    ...requestOptions,
    refFileIds: [...(requestOptions.refFileIds ?? []), ...refFileIds]
  };
}

function createThinkingTagger() {
  let currentKind = null;

  return {
    flush() {
      if (currentKind !== "thinking") {
        return "";
      }

      currentKind = "response";
      return THINK_CLOSE_TAG;
    },
    push(delta) {
      if (!delta?.text) {
        return "";
      }

      let prefix = "";
      if (delta.kind !== currentKind) {
        if (currentKind === "thinking") {
          prefix += THINK_CLOSE_TAG;
        }
        if (delta.kind === "thinking") {
          prefix += THINK_OPEN_TAG;
        }
        currentKind = delta.kind;
      }

      return prefix + delta.text;
    }
  };
}

async function consumeTaggedStream(stream, onText) {
  if (!stream) {
    return;
  }

  const decoder = new TextDecoder();
  const deltaDecoder = createDeepseekDeltaDecoder();
  const tagger = createThinkingTagger();
  const parser = createSseParser(({ data }) => {
    const text = tagger.push(deltaDecoder.consume(data));
    if (text) {
      onText(text);
    }
  });

  for await (const chunk of stream) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }

  parser.flush();
  const suffix = tagger.flush();
  if (suffix) {
    onText(suffix);
  }
}

/**
 * Run a completion (or continue) within a session context.
 *
 * If `continueSessionId` is provided, reuses that session and calls
 * /chat/continue to extend the last assistant response. Otherwise
 * creates a new session.
 *
 * @param {Object} options
 * @param {Object} options.account
 * @param {boolean} [options.deleteAfterFinish=false]
 * @param {function(string): Promise<{content: string, sessionId: string}>} options.onComplete
 *        Called with the sessionId. Must return {content, sessionId}.
 * @param {string} [options.continueSessionId] If set, continue this session instead of creating a new one.
 * @returns {Promise<{content: string, sessionId: string}>}
 */
async function withCompletionSession({ account, continueSessionId, deleteAfterFinish, onComplete }) {
  if (continueSessionId) {
    // Continue mode: reuse the provided session, don't create or delete
    return onComplete(continueSessionId);
  }

  const sessionId = await createChatSession(account);

  try {
    return await onComplete(sessionId);
  } finally {
    if (deleteAfterFinish) {
      await deleteChatSession(account, sessionId);
    }
  }
}

export async function collectCompletionContent({
  account,
  continueSessionId = null,
  deleteAfterFinish = false,
  requestOptions
}) {
  return withCompletionSession({
    account,
    continueSessionId,
    deleteAfterFinish,
    onComplete: async (sessionId) => {
      let content = "";

      if (continueSessionId) {
        // Continue mode: use /chat/continue
        const preparedOptions = await prepareRequestOptions({ account, requestOptions, sessionId });
        const { response } = await continueCompletion({ account, requestOptions: preparedOptions, sessionId });
        await consumeTaggedStream(response.body, (text) => {
          content += text;
        });
      } else {
        // New completion: create session and run /chat/completion
        const preparedOptions = await prepareRequestOptions({ account, requestOptions, sessionId });
        const { response } = await startCompletion({ account, requestOptions: preparedOptions, sessionId });
        await consumeTaggedStream(response.body, (text) => {
          content += text;
        });
      }

      return { content, sessionId };
    }
  });
}

export async function streamCompletionContent({
  account,
  continueSessionId = null,
  deleteAfterFinish = false,
  onText,
  requestOptions
}) {
  return withCompletionSession({
    account,
    continueSessionId,
    deleteAfterFinish,
    onComplete: async (sessionId) => {
      if (continueSessionId) {
        const preparedOptions = await prepareRequestOptions({ account, requestOptions, sessionId });
        const { response } = await continueCompletion({ account, requestOptions: preparedOptions, sessionId });
        await consumeTaggedStream(response.body, onText);
      } else {
        const preparedOptions = await prepareRequestOptions({ account, requestOptions, sessionId });
        const { response } = await startCompletion({ account, requestOptions: preparedOptions, sessionId });
        await consumeTaggedStream(response.body, onText);
      }

      return { sessionId };
    }
  });
}