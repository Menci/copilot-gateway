// POST /v1/chat/completions — passthrough, translate via Messages API, or via Responses API

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { copilotFetch } from "../lib/copilot.ts";
import {
  probeChatCompletionsThinkingBudget,
  selectResponsesReasoningEffortForChat,
} from "../lib/copilot-probes.ts";
import { getGithubCredentials } from "../lib/github.ts";
import { findModel } from "../lib/models-cache.ts";
import { parseSSEStream } from "../lib/sse.ts";
import {
  isSSEResponse,
  reassembleAnthropicSSE,
  reassembleChatCompletionsSSE,
  reassembleResponsesSSE,
} from "../lib/sse-reassemble.ts";
import type {
  AnthropicResponse,
  AnthropicStreamEventData,
} from "../lib/anthropic-types.ts";
import type { ChatCompletionsPayload } from "../lib/openai-types.ts";
import type { ResponseStreamEvent } from "../lib/responses-types.ts";
import {
  fetchRemoteImage,
  translateChatToMessages,
} from "../lib/translate/chat-to-messages.ts";
import { translateMessagesToChatCompletion } from "../lib/translate/messages-to-chat.ts";
import {
  createChatStreamState,
  translateAnthropicEventToChatChunks,
} from "../lib/translate/messages-to-chat-stream.ts";
import {
  createResponsesToChatStreamState,
  translateChatToResponses,
  translateResponsesEventToChatChunks,
  translateResponsesToChatCompletion,
} from "../lib/translate/chat-to-responses.ts";
import {
  apiErrorResponse,
  getErrorMessage,
  noUpstreamBodyApiErrorResponse,
  proxyJsonResponse,
} from "./proxy-utils.ts";

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

/** Detect if request body contains image content */
function hasVision(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return msg.content.some(
      (part: { type?: string }) => part.type === "image_url",
    );
  });
}

// deno-lint-ignore no-explicit-any
type ChatChoice = Record<string, any>;
// deno-lint-ignore no-explicit-any
type ChatResponse = Record<string, any>;

/**
 * XXX: Copilot upstream bug — when converting Anthropic multi-block responses
 * (text + tool_use) to Chat Completions format, it creates one choice per
 * content block instead of merging them into a single choice.
 * We merge them back: concatenate content strings, collect tool_calls.
 */
function mergeChoices(data: ChatResponse): ChatResponse {
  const choices = data.choices as ChatChoice[] | undefined;
  if (!Array.isArray(choices) || choices.length <= 1) return data;

  const merged: ChatChoice = { ...choices[0], index: 0 };
  const msg = { ...merged.message };
  let content = msg.content ?? "";
  // deno-lint-ignore no-explicit-any
  const toolCalls: any[] = msg.tool_calls ? [...msg.tool_calls] : [];
  let finishReason = merged.finish_reason;

  for (let i = 1; i < choices.length; i++) {
    const c = choices[i];
    if (c.message?.content) {
      content += c.message.content;
    }
    if (c.message?.tool_calls) {
      toolCalls.push(...c.message.tool_calls);
    }
    if (c.finish_reason) finishReason = c.finish_reason;
  }

  msg.content = content || null;
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  merged.message = msg;
  merged.finish_reason = finishReason;

  return { ...data, choices: [merged] };
}

/**
 * Fix streaming chunks: remap all choice indices to 0 so split choices
 * are treated as a single response by the client.
 */
function fixStreamLine(line: string): string {
  if (!line.startsWith("data: ") || line === "data: [DONE]") return line;
  try {
    const data = JSON.parse(line.slice(6)) as ChatResponse;
    const choices = data.choices as ChatChoice[] | undefined;
    if (Array.isArray(choices)) {
      for (const c of choices) c.index = 0;
      return "data: " + JSON.stringify(data);
    }
  } catch { /* pass through unparseable lines */ }
  return line;
}

function fixStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!; // keep incomplete last line
        for (const line of lines) {
          controller.enqueue(encoder.encode(fixStreamLine(line) + "\n"));
        }
      },
      flush(controller) {
        if (buffer) {
          controller.enqueue(encoder.encode(fixStreamLine(buffer) + "\n"));
        }
      },
    }),
  );
}

export const chatCompletions = async (c: Context) => {
  try {
    const body = await c.req.json<ChatCompletionsPayload>();
    const { token: githubToken, accountType } = await getGithubCredentials();

    const route = await decideRoute(body, githubToken, accountType);

    if (route === "messages") {
      return await handleViaMessagesApi(
        c,
        body as ChatCompletionsPayload,
        githubToken,
        accountType,
      );
    }

    if (route === "responses") {
      return await handleViaResponsesApi(
        c,
        body as ChatCompletionsPayload,
        githubToken,
        accountType,
      );
    }

    return await handleViaCompletionsApi(c, body, githubToken, accountType);
  } catch (e: unknown) {
    return apiErrorResponse(c, getErrorMessage(e), 502);
  }
};

async function decideRoute(
  payload: ChatCompletionsPayload,
  githubToken: string,
  accountType: string,
): Promise<"messages" | "responses" | "completions"> {
  const modelId = payload.model ?? "";
  const wantsBudgetThinking = typeof payload.thinking_budget === "number";
  const model = await findModel(modelId, githubToken, accountType);
  if (model) {
    const endpoints = model.supported_endpoints ?? [];
    if (endpoints.includes("/v1/messages")) return "messages";
    if (wantsBudgetThinking && endpoints.includes("/responses")) {
      return "responses";
    }
    if (endpoints.includes("/chat/completions")) return "completions";
    if (endpoints.includes("/responses")) return "responses";
    return "completions";
  }
  // Fallback when models cache is unavailable
  return modelId.startsWith("claude") ? "messages" : "completions";
}

async function handleViaMessagesApi(
  c: Context,
  payload: ChatCompletionsPayload,
  githubToken: string,
  accountType: string,
): Promise<Response> {
  const anthropicPayload = await translateChatToMessages(payload, {
    loadRemoteImage: fetchRemoteImage,
  });
  const vision = hasVision(payload as unknown as Record<string, unknown>);
  const wantsStream = !!payload.stream;

  const extraHeaders: Record<string, string> = {};
  if (anthropicPayload.thinking?.budget_tokens) {
    extraHeaders["anthropic-beta"] = INTERLEAVED_THINKING_BETA;
  }

  // Always stream upstream to avoid blocking on large responses
  anthropicPayload.stream = true;

  const resp = await copilotFetch(
    "/v1/messages",
    { method: "POST", body: JSON.stringify(anthropicPayload) },
    githubToken,
    accountType,
    {
      vision,
      ...(Object.keys(extraHeaders).length > 0 && { extraHeaders }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    return apiErrorResponse(c, `Upstream error: ${resp.status} ${text}`, 502);
  }

  // Non-streaming
  if (!wantsStream) {
    let anthropicResponse: AnthropicResponse;
    if (resp.body && isSSEResponse(resp)) {
      anthropicResponse = await reassembleAnthropicSSE(resp.body);
    } else {
      anthropicResponse = await resp.json() as AnthropicResponse;
    }
    return c.json(translateMessagesToChatCompletion(anthropicResponse));
  }

  // Streaming
  if (!resp.body) return noUpstreamBodyApiErrorResponse(c);

  return streamSSE(c, async (stream) => {
    const state = createChatStreamState();

    for await (const rawEvent of parseSSEStream(resp.body!)) {
      if (!rawEvent.data) continue;

      let eventData: AnthropicStreamEventData;
      try {
        eventData = JSON.parse(rawEvent.data) as AnthropicStreamEventData;
      } catch {
        continue;
      }

      const result = translateAnthropicEventToChatChunks(eventData, state);

      if (result === "DONE") {
        await stream.writeSSE({ data: "[DONE]" });
        break;
      }

      for (const chunk of result) {
        await stream.writeSSE({ data: JSON.stringify(chunk) });
      }
    }
  });
}

async function handleViaResponsesApi(
  c: Context,
  payload: ChatCompletionsPayload,
  githubToken: string,
  accountType: string,
): Promise<Response> {
  const reasoningEffort = await selectResponsesReasoningEffortForChat(
    payload,
    githubToken,
    accountType,
  );
  const responsesPayload = translateChatToResponses(payload, {
    reasoningEffort,
  });
  const vision = hasVision(payload as unknown as Record<string, unknown>);
  const wantsStream = !!payload.stream;

  // Always stream upstream to avoid blocking on large responses
  responsesPayload.stream = true;

  const resp = await copilotFetch(
    "/responses",
    { method: "POST", body: JSON.stringify(responsesPayload) },
    githubToken,
    accountType,
    { vision },
  );

  if (!resp.ok) {
    const text = await resp.text();
    return apiErrorResponse(c, `Upstream error: ${resp.status} ${text}`, 502);
  }

  // Non-streaming
  if (!wantsStream) {
    let result;
    if (resp.body && isSSEResponse(resp)) {
      result = await reassembleResponsesSSE(resp.body);
    } else {
      result = await resp.json();
    }
    return c.json(translateResponsesToChatCompletion(result));
  }

  // Streaming
  if (!resp.body) return noUpstreamBodyApiErrorResponse(c);

  return streamSSE(c, async (stream) => {
    const state = createResponsesToChatStreamState();

    for await (const rawEvent of parseSSEStream(resp.body!)) {
      if (!rawEvent.data) continue;

      let eventData: ResponseStreamEvent;
      try {
        eventData = JSON.parse(rawEvent.data) as ResponseStreamEvent;
      } catch {
        continue;
      }

      // Attach event name if not present in data
      if (rawEvent.event && !eventData.type) {
        eventData = { ...eventData, type: rawEvent.event };
      }

      const result = translateResponsesEventToChatChunks(eventData, state);

      if (result === "DONE") {
        await stream.writeSSE({ data: "[DONE]" });
        break;
      }

      for (const chunk of result) {
        await stream.writeSSE({ data: JSON.stringify(chunk) });
      }
    }

    // Ensure [DONE] is always sent
    if (!state.done) {
      await stream.writeSSE({ data: "[DONE]" });
    }
  });
}

async function handleViaCompletionsApi(
  c: Context,
  body: ChatCompletionsPayload,
  githubToken: string,
  accountType: string,
): Promise<Response> {
  if (typeof body.thinking_budget === "number") {
    try {
      const supported = await probeChatCompletionsThinkingBudget(
        body.model,
        githubToken,
        accountType,
      );
      if (!supported) delete body.thinking_budget;
    } catch (error) {
      console.warn("Failed to probe Chat Completions thinking_budget:", error);
      delete body.thinking_budget;
    }
  }

  const vision = hasVision(body as unknown as Record<string, unknown>);
  const needsFix = (typeof body.model === "string") &&
    body.model.startsWith("claude");
  const wantsStream = !!body.stream;

  // Always stream upstream to avoid blocking on large responses
  body.stream = true;
  if (!body.stream_options) {
    body.stream_options = { include_usage: true };
  }

  const resp = await copilotFetch(
    "/chat/completions",
    { method: "POST", body: JSON.stringify(body) },
    githubToken,
    accountType,
    { vision },
  );

  const contentType = resp.headers.get("content-type") ?? "application/json";

  if (wantsStream) {
    if (contentType.includes("text/event-stream")) {
      const stream = needsFix && resp.body ? fixStream(resp.body) : resp.body;
      return new Response(stream, {
        status: resp.status,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }

    // Upstream returned JSON even though we asked for streaming — proxy as-is
    return proxyJsonResponse(resp);
  }

  // Client wants non-streaming response
  if (contentType.includes("text/event-stream") && resp.body) {
    const data = await reassembleChatCompletionsSSE(resp.body);
    if (needsFix) {
      return c.json(mergeChoices(data), resp.status as 200);
    }
    return c.json(data, resp.status as 200);
  }

  if (needsFix && resp.status >= 200 && resp.status < 300) {
    const data = await resp.json() as ChatResponse;
    return c.json(mergeChoices(data), resp.status as 200);
  }

  return proxyJsonResponse(resp);
}
