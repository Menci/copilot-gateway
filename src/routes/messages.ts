import type { Context } from "hono";
import { copilotFetch, type CopilotFetchOptions } from "../lib/copilot.ts";
import {
  probeChatCompletionsThinkingBudget,
  selectResponsesReasoningEffortForAnthropic,
} from "../lib/copilot-probes.ts";
import { getGithubCredentials } from "../lib/github.ts";
import { modelSupportsEndpoint } from "../lib/models-cache.ts";
import { getAnthropicRequestedReasoningEffort } from "../lib/reasoning.ts";
import type {
  AnthropicMessagesPayload,
  AnthropicStreamState,
} from "../lib/anthropic-types.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../lib/openai-types.ts";
import {
  translateToAnthropic,
  translateToOpenAI,
} from "../lib/translate/openai.ts";
import { translateChunkToAnthropicEvents } from "../lib/translate/openai-stream.ts";
import {
  translateAnthropicToResponses,
  translateResponsesToAnthropic,
} from "../lib/translate/responses.ts";
import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "../lib/translate/responses-stream.ts";
import { filterThinkingBlocks } from "../lib/translate/utils.ts";
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../lib/responses-types.ts";
import { proxySSE } from "../lib/sse.ts";
import {
  isSSEResponse,
  reassembleAnthropicSSE,
  reassembleChatCompletionsSSE,
  reassembleResponsesSSE,
} from "../lib/sse-reassemble.ts";
import {
  anthropicApiErrorResponse,
  anthropicCopilotApiErrorResponse,
  getErrorMessage,
  noUpstreamBodyAnthropicErrorResponse,
} from "./proxy-utils.ts";

const ALLOWED_ANTHROPIC_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "advanced-tool-use-2025-11-20",
]);

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function filterAnthropicBeta(
  header: string | undefined,
  isAdaptiveThinking = false,
): string | undefined {
  if (!header) return undefined;
  let filtered = header.split(",").map((s) => s.trim()).filter((s) =>
    s.length > 0 && ALLOWED_ANTHROPIC_BETAS.has(s)
  );
  if (isAdaptiveThinking) {
    filtered = filtered.filter((s) => s !== INTERLEAVED_THINKING_BETA);
  }
  return filtered.length > 0 ? [...new Set(filtered)].join(",") : undefined;
}

function hasVision(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some((block) => block.type === "image"),
  );
}

function getInitiator(payload: AnthropicMessagesPayload): "user" | "agent" {
  const lastMsg = payload.messages[payload.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "user") return "agent";
  if (Array.isArray(lastMsg.content)) {
    return lastMsg.content.some((block) => block.type !== "tool_result")
      ? "user"
      : "agent";
  }
  return "user";
}

function isContextWindowError(text: string): boolean {
  return text.includes("Request body is too large for model context window") ||
    text.includes("context_length_exceeded");
}

/** Copilot rejects requests containing this string in system prompts */
const RESERVED_KEYWORD = "x-anthropic-billing-header";

function stripReservedKeywords(payload: AnthropicMessagesPayload): void {
  if (typeof payload.system === "string") {
    payload.system = payload.system.replaceAll(RESERVED_KEYWORD, "");
  } else if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      block.text = block.text.replaceAll(RESERVED_KEYWORD, "");
    }
  }
  for (const msg of payload.messages) {
    if (typeof msg.content === "string") {
      msg.content = msg.content.replaceAll(RESERVED_KEYWORD, "");
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") {
          block.text = block.text.replaceAll(RESERVED_KEYWORD, "");
        }
      }
    }
  }
}

/** Strip unsupported `scope` from cache_control — Copilot API rejects it */
function stripCacheControlScope(payload: AnthropicMessagesPayload): void {
  // deno-lint-ignore no-explicit-any
  const strip = (block: any) => {
    const cc = block.cache_control;
    if (cc && typeof cc === "object") {
      const { scope: _, ...rest } = cc as Record<string, unknown>;
      block.cache_control = Object.keys(rest).length > 0 ? rest : undefined;
    }
  };
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) strip(block);
  }
  for (const msg of payload.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) strip(block);
    }
  }
}

/** Anthropic-compatible error that triggers compact in Claude Code */
function contextWindowErrorResponse(c: Context) {
  return c.json({
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.",
    },
  }, 400);
}

export const messages = async (c: Context) => {
  try {
    const payload = await c.req.json<AnthropicMessagesPayload>();

    const { token: githubToken, accountType } = await getGithubCredentials();

    // Strip web_search tools — Copilot doesn't support them
    if (payload.tools) {
      payload.tools = payload.tools.filter((t) =>
        !("type" in t && t.type === "web_search")
      );
      if (payload.tools.length === 0) delete payload.tools;
    }

    stripReservedKeywords(payload);
    stripCacheControlScope(payload);

    const vision = hasVision(payload);
    const initiator = getInitiator(payload);
    const rawBeta = c.req.header("anthropic-beta");

    const supportsMessages = await modelSupportsEndpoint(
      payload.model,
      "/v1/messages",
      githubToken,
      accountType,
    );
    const supportsResponses = await modelSupportsEndpoint(
      payload.model,
      "/responses",
      githubToken,
      accountType,
    );
    const supportsChatCompletions = await modelSupportsEndpoint(
      payload.model,
      "/chat/completions",
      githubToken,
      accountType,
    );
    const requestedReasoningEffort = getAnthropicRequestedReasoningEffort(
      payload,
    );
    const responsesReasoningEffort =
      supportsResponses && requestedReasoningEffort
        ? await selectResponsesReasoningEffortForAnthropic(
          payload,
          githubToken,
          accountType,
        )
        : null;

    if (supportsMessages) {
      return await handleNativeMessages(c, payload, githubToken, accountType, {
        vision,
        initiator,
        rawBeta,
      });
    }

    if (supportsResponses && requestedReasoningEffort) {
      return await handleWithResponses(c, payload, githubToken, accountType, {
        vision,
        initiator,
        reasoningEffort: responsesReasoningEffort,
      });
    }

    if (supportsResponses && !supportsChatCompletions) {
      return await handleWithResponses(c, payload, githubToken, accountType, {
        vision,
        initiator,
        reasoningEffort: responsesReasoningEffort,
      });
    }

    let allowThinkingBudget = true;
    if (payload.thinking?.budget_tokens && supportsChatCompletions) {
      try {
        allowThinkingBudget = await probeChatCompletionsThinkingBudget(
          payload.model,
          githubToken,
          accountType,
        );
      } catch (error) {
        console.warn(
          "Failed to probe Chat Completions thinking_budget:",
          error,
        );
        allowThinkingBudget = false;
      }
    }

    return await handleTranslated(c, payload, githubToken, accountType, {
      vision,
      initiator,
      allowThinkingBudget,
    });
  } catch (e: unknown) {
    return anthropicApiErrorResponse(c, getErrorMessage(e), 502);
  }
};

function handleNativeMessages(
  c: Context,
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
  opts: { vision: boolean; initiator: "user" | "agent"; rawBeta?: string },
): Promise<Response> {
  filterThinkingBlocks(payload);

  const isAdaptive = payload.thinking?.type === "adaptive";
  let anthropicBeta = filterAnthropicBeta(opts.rawBeta, isAdaptive);

  // Auto-add interleaved-thinking beta for budget-based thinking
  if (
    payload.thinking?.budget_tokens && !isAdaptive &&
    !anthropicBeta?.includes(INTERLEAVED_THINKING_BETA)
  ) {
    anthropicBeta = anthropicBeta
      ? `${anthropicBeta},${INTERLEAVED_THINKING_BETA}`
      : INTERLEAVED_THINKING_BETA;
  }

  const fetchOptions: CopilotFetchOptions = {
    vision: opts.vision,
    initiator: opts.initiator,
  };
  if (anthropicBeta) {
    fetchOptions.extraHeaders = { "anthropic-beta": anthropicBeta };
  }

  return forwardMessages(c, payload, githubToken, accountType, fetchOptions);
}

async function forwardMessages(
  c: Context,
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
  fetchOptions: CopilotFetchOptions,
): Promise<Response> {
  const { service_tier: _, ...cleanPayload } = payload;
  const wantsStream = !!payload.stream;

  // Always stream upstream to avoid blocking on large responses
  cleanPayload.stream = true;

  const resp = await copilotFetch(
    "/v1/messages",
    { method: "POST", body: JSON.stringify(cleanPayload) },
    githubToken,
    accountType,
    fetchOptions,
  );

  if (!resp.ok) {
    const text = await resp.text();
    return isContextWindowError(text)
      ? contextWindowErrorResponse(c)
      : anthropicCopilotApiErrorResponse(
        c,
        resp.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
        text,
      );
  }

  if (!wantsStream) {
    if (!resp.body || !isSSEResponse(resp)) {
      return c.json(await resp.json());
    }
    return c.json(await reassembleAnthropicSSE(resp.body));
  }

  if (!resp.body) return noUpstreamBodyAnthropicErrorResponse(c);

  return proxySSE(c, resp.body, (event, data) => {
    if (data.trim() === "[DONE]") return null;
    return [{ event: event || undefined, data }];
  }, "Native messages");
}

async function handleTranslated(
  c: Context,
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
  opts: {
    vision: boolean;
    initiator: "user" | "agent";
    allowThinkingBudget?: boolean;
  },
): Promise<Response> {
  const fetchOptions: CopilotFetchOptions = {
    vision: opts.vision,
    initiator: opts.initiator,
  };

  const openAIPayload = translateToOpenAI(payload, {
    allowThinkingBudget: opts.allowThinkingBudget,
  });
  const wantsStream = !!payload.stream;

  // Always stream upstream to avoid blocking on large responses
  openAIPayload.stream = true;
  openAIPayload.stream_options = { include_usage: true };

  const resp = await copilotFetch(
    "/chat/completions",
    { method: "POST", body: JSON.stringify(openAIPayload) },
    githubToken,
    accountType,
    fetchOptions,
  );

  if (!resp.ok) {
    const text = await resp.text();
    return isContextWindowError(text)
      ? contextWindowErrorResponse(c)
      : anthropicCopilotApiErrorResponse(
        c,
        resp.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
        text,
      );
  }

  if (!wantsStream) {
    let chatResp: ChatCompletionResponse;
    if (resp.body && isSSEResponse(resp)) {
      chatResp = await reassembleChatCompletionsSSE(resp.body);
    } else {
      chatResp = await resp.json() as ChatCompletionResponse;
    }
    return c.json(translateToAnthropic(chatResp));
  }

  if (!resp.body) return noUpstreamBodyAnthropicErrorResponse(c);

  const state: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  };

  return proxySSE(c, resp.body, (_event, data) => {
    const trimmed = data.trim();
    if (trimmed === "[DONE]" || !trimmed) return null;

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(trimmed);
    } catch {
      return null;
    }

    return translateChunkToAnthropicEvents(chunk, state)
      .map((e) => ({ event: e.type, data: JSON.stringify(e) }));
  }, "Translated");
}

async function handleWithResponses(
  c: Context,
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
  opts: {
    vision: boolean;
    initiator: "user" | "agent";
    reasoningEffort?:
      | import("../lib/reasoning.ts").ResponsesReasoningEffort
      | null;
  },
): Promise<Response> {
  const responsesPayload = translateAnthropicToResponses(payload, {
    reasoningEffort: opts.reasoningEffort,
  });
  const wantsStream = !!payload.stream;

  // Always stream upstream to avoid blocking on large responses
  responsesPayload.stream = true;

  const resp = await copilotFetch(
    "/responses",
    { method: "POST", body: JSON.stringify(responsesPayload) },
    githubToken,
    accountType,
    opts,
  );

  if (!resp.ok) {
    const text = await resp.text();
    return isContextWindowError(text)
      ? contextWindowErrorResponse(c)
      : anthropicCopilotApiErrorResponse(
        c,
        resp.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
        text,
      );
  }

  if (!wantsStream) {
    let result: ResponsesResult;
    if (resp.body && isSSEResponse(resp)) {
      result = await reassembleResponsesSSE(resp.body);
    } else {
      result = await resp.json() as ResponsesResult;
    }
    return c.json(translateResponsesToAnthropic(result));
  }

  if (!resp.body) return noUpstreamBodyAnthropicErrorResponse(c);

  const state = createResponsesStreamState();

  return proxySSE(c, resp.body, (eventName, data) => {
    if (state.messageCompleted) return null;
    const trimmed = data.trim();
    if (!trimmed) return null;

    let parsed: ResponseStreamEvent;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }

    if (eventName && !parsed.type) parsed = { ...parsed, type: eventName };

    return translateResponsesStreamEvent(parsed, state)
      .map((e) => ({ event: e.type, data: JSON.stringify(e) }));
  }, "Responses translation");
}
