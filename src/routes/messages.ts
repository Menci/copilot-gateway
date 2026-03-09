import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { copilotFetch, type CopilotFetchOptions } from "../lib/copilot.ts";
import { getEnv, getGithubTokenAsync } from "../middleware/auth.ts";
import { modelSupportsEndpoint, findModel } from "../lib/models-cache.ts";
import type {
  AnthropicMessagesPayload,
  AnthropicStreamState,
  AnthropicThinkingBlock,
} from "../lib/anthropic-types.ts";
import type { ChatCompletionChunk, ChatCompletionResponse } from "../lib/openai-types.ts";
import { translateToOpenAI, translateToAnthropic } from "../lib/translate.ts";
import { translateChunkToAnthropicEvents } from "../lib/translate-stream.ts";
import { translateAnthropicToResponses, translateResponsesToAnthropic } from "../lib/translate-responses.ts";
import { translateResponsesStreamEvent, createResponsesStreamState } from "../lib/translate-responses-stream.ts";
import type { ResponseStreamEvent, ResponsesResult } from "../lib/responses-types.ts";
import { parseSSEStream } from "../lib/sse.ts";

const ALLOWED_ANTHROPIC_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "advanced-tool-use-2025-11-20",
]);

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function filterAnthropicBeta(header: string | undefined, isAdaptiveThinking = false): string | undefined {
  if (!header) return undefined;
  let filtered = header.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && ALLOWED_ANTHROPIC_BETAS.has(s));
  if (isAdaptiveThinking) filtered = filtered.filter((s) => s !== INTERLEAVED_THINKING_BETA);
  return filtered.length > 0 ? [...new Set(filtered)].join(",") : undefined;
}

function hasVision(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (msg) => Array.isArray(msg.content) && msg.content.some((block) => block.type === "image"),
  );
}

function getInitiator(payload: AnthropicMessagesPayload): "user" | "agent" {
  const lastMsg = payload.messages[payload.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "user") return "agent";
  if (Array.isArray(lastMsg.content)) {
    return lastMsg.content.some((block) => block.type !== "tool_result") ? "user" : "agent";
  }
  return "user";
}

/**
 * Filter invalid thinking blocks for native Messages API.
 * Invalid: empty thinking, "Thinking..." placeholder, signatures with "@" (Responses API origin)
 */
function filterThinkingBlocks(payload: AnthropicMessagesPayload): void {
  for (const msg of payload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true;
        const tb = block as AnthropicThinkingBlock;
        if (!tb.thinking || tb.thinking === "Thinking...") return false;
        if (tb.signature?.includes("@")) return false;
        return true;
      });
    }
  }
}

function isContextWindowError(text: string): boolean {
  return text.includes("Request body is too large for model context window") ||
    text.includes("context_length_exceeded");
}

/** Anthropic-compatible error that triggers compact in Claude Code */
function contextWindowErrorResponse(c: Context) {
  return c.json({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.",
    },
  }, 400);
}

function copilotErrorResponse(c: Context, status: number, text: string) {
  return c.json(
    { error: { type: "api_error", message: `Copilot API error: ${status} ${text}` } },
    status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
  );
}

function noBodyResponse(c: Context) {
  return c.json({ error: { type: "api_error", message: "No response body from upstream" } }, 502);
}

export const messages = async (c: Context) => {
  try {
    const payload = await c.req.json<AnthropicMessagesPayload>();
    const githubToken = await getGithubTokenAsync();
    const accountType = getEnv("ACCOUNT_TYPE");

    // Strip web_search tools — Copilot doesn't support them
    if (payload.tools) {
      // deno-lint-ignore no-explicit-any
      payload.tools = payload.tools.filter((t) => (t as any).type !== "web_search");
      if (payload.tools.length === 0) delete payload.tools;
    }

    const vision = hasVision(payload);
    const initiator = getInitiator(payload);
    const rawBeta = c.req.header("anthropic-beta");

    const supportsMessages = await modelSupportsEndpoint(payload.model, "/v1/messages", githubToken, accountType);
    if (supportsMessages) {
      return await handleNativeMessages(c, payload, githubToken, accountType, { vision, initiator, rawBeta });
    }

    const supportsResponses = await modelSupportsEndpoint(payload.model, "/responses", githubToken, accountType);
    const supportsChatCompletions = await modelSupportsEndpoint(payload.model, "/chat/completions", githubToken, accountType);

    if (supportsResponses && !supportsChatCompletions) {
      return await handleWithResponses(c, payload, githubToken, accountType, { vision, initiator });
    }

    return await handleTranslated(c, payload, githubToken, accountType, { vision, initiator, rawBeta });
  } catch (e: unknown) {
    return c.json({ error: { type: "api_error", message: e instanceof Error ? e.message : String(e) } }, 502);
  }
};

async function handleNativeMessages(
  c: Context,
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
  opts: { vision: boolean; initiator: "user" | "agent"; rawBeta?: string },
): Promise<Response> {
  filterThinkingBlocks(payload);

  const model = await findModel(payload.model, githubToken, accountType);
  if (model?.capabilities?.supports?.adaptive_thinking) {
    payload.thinking = { type: "adaptive" };
    if (!payload.output_config?.effort) payload.output_config = { effort: "high" };
  }

  const isAdaptive = payload.thinking?.type === "adaptive";
  let anthropicBeta = filterAnthropicBeta(opts.rawBeta, isAdaptive);

  // Auto-add interleaved-thinking beta for budget-based thinking
  if (payload.thinking?.budget_tokens && !isAdaptive && !anthropicBeta?.includes(INTERLEAVED_THINKING_BETA)) {
    anthropicBeta = anthropicBeta ? `${anthropicBeta},${INTERLEAVED_THINKING_BETA}` : INTERLEAVED_THINKING_BETA;
  }

  const fetchOptions: CopilotFetchOptions = { vision: opts.vision, initiator: opts.initiator };
  if (anthropicBeta) fetchOptions.extraHeaders = { "anthropic-beta": anthropicBeta };

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

  const resp = await copilotFetch("/v1/messages", { method: "POST", body: JSON.stringify(cleanPayload) }, githubToken, accountType, fetchOptions);

  if (!resp.ok) {
    const text = await resp.text();
    return isContextWindowError(text) ? contextWindowErrorResponse(c) : copilotErrorResponse(c, resp.status, text);
  }

  if (!payload.stream) {
    return c.json(await resp.json());
  }

  if (!resp.body) return noBodyResponse(c);

  return streamSSE(c, async (stream) => {
    try {
      for await (const { event, data } of parseSSEStream(resp.body!)) {
        await stream.writeSSE({ event: event || undefined, data });
      }
    } catch (e) {
      console.error("Native messages stream error:", e);
    }
  });
}

async function handleTranslated(
  c: Context,
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
  opts: { vision: boolean; initiator: "user" | "agent"; rawBeta?: string },
): Promise<Response> {
  const anthropicBeta = filterAnthropicBeta(opts.rawBeta);
  const fetchOptions: CopilotFetchOptions = { vision: opts.vision, initiator: opts.initiator };
  if (anthropicBeta) fetchOptions.extraHeaders = { "anthropic-beta": anthropicBeta };

  const openAIPayload = translateToOpenAI(payload);
  const resp = await copilotFetch("/chat/completions", { method: "POST", body: JSON.stringify(openAIPayload) }, githubToken, accountType, fetchOptions);

  if (!resp.ok) {
    const text = await resp.text();
    return isContextWindowError(text) ? contextWindowErrorResponse(c) : copilotErrorResponse(c, resp.status, text);
  }

  if (!payload.stream) {
    return c.json(translateToAnthropic(await resp.json() as ChatCompletionResponse));
  }

  if (!resp.body) return noBodyResponse(c);

  return streamSSE(c, async (stream) => {
    const state: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    };

    try {
      for await (const { data } of parseSSEStream(resp.body!)) {
        const trimmed = data.trim();
        if (trimmed === "[DONE]" || !trimmed) continue;

        let chunk: ChatCompletionChunk;
        try { chunk = JSON.parse(trimmed); } catch { continue; }

        for (const event of translateChunkToAnthropicEvents(chunk, state)) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
      }
    } catch (e) {
      console.error("Translated stream error:", e);
    }
  });
}

async function handleWithResponses(
  c: Context,
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
  opts: { vision: boolean; initiator: "user" | "agent" },
): Promise<Response> {
  const responsesPayload = translateAnthropicToResponses(payload);
  const resp = await copilotFetch("/responses", { method: "POST", body: JSON.stringify(responsesPayload) }, githubToken, accountType, opts);

  if (!resp.ok) {
    const text = await resp.text();
    return isContextWindowError(text) ? contextWindowErrorResponse(c) : copilotErrorResponse(c, resp.status, text);
  }

  if (!payload.stream) {
    return c.json(translateResponsesToAnthropic(await resp.json() as ResponsesResult));
  }

  if (!resp.body) return noBodyResponse(c);

  return streamSSE(c, async (stream) => {
    const state = createResponsesStreamState();

    try {
      for await (const { event: eventName, data } of parseSSEStream(resp.body!)) {
        const trimmed = data.trim();
        if (!trimmed) continue;

        let parsed: ResponseStreamEvent;
        try { parsed = JSON.parse(trimmed); } catch { continue; }

        if (eventName && !parsed.type) parsed = { ...parsed, type: eventName };

        for (const event of translateResponsesStreamEvent(parsed, state)) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }

        if (state.messageCompleted) break;
      }

      if (!state.messageCompleted && !state.messageStartSent) {
        console.warn("Responses stream ended without completion");
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", error: { type: "api_error", message: "Stream ended without response" } }),
        });
      }
    } catch (e) {
      console.error("Responses translation stream error:", e);
    }
  });
}
