/**
 * SSE stream reassembly functions.
 *
 * When we force `stream: true` upstream, these functions consume the SSE
 * stream and reassemble the full non-streaming response object.
 */

import { parseSSEStream } from "./sse.ts";
import { isRecord } from "./type-guards.ts";
import type {
  MessagesAssistantContentBlock,
  MessagesResponse,
  MessagesServerToolUseBlock,
  MessagesTextCitation,
  MessagesToolUseBlock,
  MessagesWebSearchToolResultBlock,
} from "./messages-types.ts";
import type {
  ChatCompletionResponse,
  ChoiceNonStreaming,
  ToolCall,
} from "./chat-completions-types.ts";
import type { ResponsesResult } from "./responses-types.ts";

/** Check if an upstream response is SSE (vs plain JSON fallback). */
export function isSSEResponse(resp: Response): boolean {
  const ct = resp.headers.get("content-type") ?? "";
  return ct.includes("text/event-stream");
}

const normalizeMessagesTextCitation = (
  value: unknown,
): MessagesTextCitation | null => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  if (value.type === "search_result_location") {
    const url = typeof value.url === "string"
      ? value.url
      : typeof value.source === "string"
      ? value.source
      : null;

    if (
      !url || typeof value.title !== "string" ||
      !Number.isInteger(value.search_result_index) ||
      !Number.isInteger(value.start_block_index) ||
      !Number.isInteger(value.end_block_index)
    ) {
      return null;
    }

    return {
      type: "search_result_location",
      url,
      title: value.title,
      search_result_index: value.search_result_index as number,
      start_block_index: value.start_block_index as number,
      end_block_index: value.end_block_index as number,
      ...(typeof value.cited_text === "string"
        ? { cited_text: value.cited_text }
        : {}),
    };
  }

  if (value.type === "web_search_result_location") {
    const url = typeof value.url === "string"
      ? value.url
      : typeof value.source === "string"
      ? value.source
      : null;

    if (
      !url || typeof value.title !== "string" ||
      typeof value.encrypted_index !== "string"
    ) {
      return null;
    }

    return {
      type: "web_search_result_location",
      url,
      title: value.title,
      encrypted_index: value.encrypted_index,
      ...(typeof value.cited_text === "string"
        ? { cited_text: value.cited_text }
        : {}),
    };
  }

  return null;
};

const normalizeMessagesTextCitations = (
  value: unknown,
): MessagesTextCitation[] =>
  Array.isArray(value)
    ? value.flatMap((citation) => {
      const normalized = normalizeMessagesTextCitation(citation);
      return normalized ? [normalized] : [];
    })
    : [];

type TextBlockAccumulator = {
  type: "text";
  text: string;
  citations: MessagesTextCitation[];
};

type ToolUseBlockAccumulator = {
  type: "tool_use";
  id: string;
  name: string;
  inputJson: string;
  input: MessagesToolUseBlock["input"];
};

type ServerToolUseBlockAccumulator = {
  type: "server_tool_use";
  id: string;
  name: MessagesServerToolUseBlock["name"];
  input: MessagesServerToolUseBlock["input"];
};

type WebSearchToolResultBlockAccumulator = {
  type: "web_search_tool_result";
  toolUseId: string;
  content: MessagesWebSearchToolResultBlock["content"];
};

type ThinkingBlockAccumulator = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

type RedactedThinkingBlockAccumulator = {
  type: "redacted_thinking";
  data: string;
};

type BlockAccumulator =
  | TextBlockAccumulator
  | ToolUseBlockAccumulator
  | ServerToolUseBlockAccumulator
  | WebSearchToolResultBlockAccumulator
  | ThinkingBlockAccumulator
  | RedactedThinkingBlockAccumulator;

// ── Messages SSE → MessagesResponse ──

export async function reassembleMessagesSSE(
  body: ReadableStream<Uint8Array>,
): Promise<MessagesResponse> {
  let id = "";
  let model = "";
  let usage: MessagesResponse["usage"] = {
    input_tokens: 0,
    output_tokens: 0,
  };
  let stopReason: MessagesResponse["stop_reason"] = null;
  let stopSequence: string | null = null;

  const blocks: Array<BlockAccumulator | undefined> = [];

  for await (const raw of parseSSEStream(body)) {
    if (!raw.data) continue;
    const trimmed = raw.data.trim();
    if (trimmed === "[DONE]" || !trimmed) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const type = event.type as string;

    if (type === "message_start") {
      const msg = event.message as Record<string, unknown>;
      id = msg.id as string;
      model = msg.model as string;
      if (msg.usage) {
        const u = msg.usage as Record<string, unknown>;
        usage = {
          input_tokens: (u.input_tokens as number) ?? 0,
          output_tokens: (u.output_tokens as number) ?? 0,
          ...(u.cache_creation_input_tokens != null && {
            cache_creation_input_tokens: u
              .cache_creation_input_tokens as number,
          }),
          ...(u.cache_read_input_tokens != null && {
            cache_read_input_tokens: u.cache_read_input_tokens as number,
          }),
          ...(u.service_tier != null && {
            service_tier: u.service_tier as "standard" | "priority" | "batch",
          }),
          ...(u.server_tool_use != null && {
            server_tool_use: u.server_tool_use as {
              web_search_requests?: number;
            },
          }),
        };
      }
      continue;
    }

    if (type === "content_block_start") {
      const idx = event.index as number;
      const cb = event.content_block as Record<string, unknown>;
      const cbType = cb.type as string;

      if (cbType === "text") {
        blocks[idx] = {
          type: "text",
          text: (cb.text as string) ?? "",
          citations: normalizeMessagesTextCitations(cb.citations),
        };
      } else if (cbType === "tool_use") {
        blocks[idx] = {
          type: "tool_use",
          id: cb.id as string,
          name: cb.name as string,
          input: {},
          inputJson: "",
        };
      } else if (cbType === "server_tool_use") {
        blocks[idx] = {
          type: "server_tool_use",
          id: cb.id as string,
          name: cb.name as MessagesServerToolUseBlock["name"],
          input: cb.input as MessagesServerToolUseBlock["input"],
        };
      } else if (cbType === "web_search_tool_result") {
        blocks[idx] = {
          type: "web_search_tool_result",
          toolUseId: cb.tool_use_id as string,
          content: cb.content as MessagesWebSearchToolResultBlock["content"],
        };
      } else if (cbType === "thinking") {
        blocks[idx] = {
          type: "thinking",
          thinking: (cb.thinking as string) ?? "",
          signature: "",
        };
      } else if (cbType === "redacted_thinking") {
        blocks[idx] = { type: "redacted_thinking", data: cb.data as string };
      }
      continue;
    }

    if (type === "content_block_delta") {
      const idx = event.index as number;
      const delta = event.delta as Record<string, unknown>;
      const deltaType = delta.type as string;
      const block = blocks[idx];
      if (!block) continue;

      if (deltaType === "text_delta" && block.type === "text") {
        block.text += (delta.text as string) ?? "";
        block.citations.push(...normalizeMessagesTextCitations(delta.citations));
      } else if (deltaType === "citations_delta" && block.type === "text") {
        const citation = normalizeMessagesTextCitation(delta.citation);
        if (citation) block.citations.push(citation);
      } else if (
        deltaType === "input_json_delta" && block.type === "tool_use"
      ) {
        block.inputJson += (delta.partial_json as string) ?? "";
      } else if (deltaType === "thinking_delta" && block.type === "thinking") {
        block.thinking += (delta.thinking as string) ?? "";
      } else if (
        deltaType === "signature_delta" && block.type === "thinking"
      ) {
        block.signature = (block.signature ?? "") +
          ((delta.signature as string) ?? "");
      }
      continue;
    }

    if (type === "content_block_stop") {
      const idx = event.index as number;
      const block = blocks[idx];
      if (block?.type === "tool_use" && block.inputJson) {
        try {
          block.input = JSON.parse(block.inputJson);
        } catch {
          block.input = {};
        }
      }
      continue;
    }

    if (type === "message_delta") {
      const delta = event.delta as Record<string, unknown>;
      if (delta.stop_reason != null) {
        stopReason = delta.stop_reason as MessagesResponse["stop_reason"];
      }
      if ("stop_sequence" in delta) {
        stopSequence = delta.stop_sequence as string | null;
      }
      if (event.usage) {
        const u = event.usage as Record<string, unknown>;
        if (u.output_tokens != null) {
          usage.output_tokens = u.output_tokens as number;
        }
        if (u.cache_creation_input_tokens != null) {
          usage.cache_creation_input_tokens = u
            .cache_creation_input_tokens as number;
        }
        if (u.cache_read_input_tokens != null) {
          usage.cache_read_input_tokens = u.cache_read_input_tokens as number;
        }
        if (u.server_tool_use != null) {
          usage.server_tool_use = u.server_tool_use as {
            web_search_requests?: number;
          };
        }
      }
      continue;
    }

    if (type === "error") {
      const err = event.error as Record<string, unknown>;
      throw new Error(
        `Upstream SSE error: ${err?.type ?? "unknown"}: ${
          err?.message ?? JSON.stringify(event)
        }`,
      );
    }
  }

  const content: MessagesAssistantContentBlock[] = [];
  for (const block of blocks) {
    if (!block) continue;

    switch (block.type) {
      case "text":
        content.push({
          type: "text",
          text: block.text,
          ...(block.citations.length > 0 ? { citations: block.citations } : {}),
        });
        break;
      case "tool_use":
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
      case "server_tool_use":
        content.push({
          type: "server_tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
      case "web_search_tool_result":
        content.push({
          type: "web_search_tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
        });
        break;
      case "thinking":
        content.push({
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        });
        break;
      case "redacted_thinking":
        content.push({ type: "redacted_thinking", data: block.data });
        break;
    }
  }

  return {
    id,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage,
  };
}

export const reassembleAnthropicSSE = reassembleMessagesSSE;

// ── Chat Completions SSE → ChatCompletionResponse ──

export async function reassembleChatCompletionsSSE(
  body: ReadableStream<Uint8Array>,
): Promise<ChatCompletionResponse> {
  let id = "";
  let model = "";
  let created = 0;
  let content = "";
  let reasoningText = "";
  let reasoningOpaque = "";
  let finishReason: ChoiceNonStreaming["finish_reason"] = "stop";
  let lastUsage: ChatCompletionResponse["usage"] | undefined;

  const toolCallsMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const raw of parseSSEStream(body)) {
    if (!raw.data) continue;
    const trimmed = raw.data.trim();
    if (trimmed === "[DONE]" || !trimmed) continue;

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!id && chunk.id) {
      id = chunk.id as string;
      model = chunk.model as string;
      created = chunk.created as number;
    }

    if (chunk.usage) {
      lastUsage = chunk.usage as ChatCompletionResponse["usage"];
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    if (!choices) continue;

    for (const choice of choices) {
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      if (typeof delta.content === "string") {
        content += delta.content;
      }
      if (typeof delta.reasoning_text === "string") {
        reasoningText += delta.reasoning_text;
      }
      if (typeof delta.reasoning_opaque === "string") {
        reasoningOpaque += delta.reasoning_opaque;
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls as Array<Record<string, unknown>>) {
          const idx = toolCall.index as number;
          const existing = toolCallsMap.get(idx);
          if (!existing) {
            toolCallsMap.set(idx, {
              id: (toolCall.id as string) ?? "",
              name:
                (toolCall.function as Record<string, unknown>)?.name as string ??
                  "",
              arguments:
                (toolCall.function as Record<string, unknown>)?.arguments as string ??
                  "",
            });
          } else {
            if (toolCall.id) existing.id = toolCall.id as string;
            const fn = toolCall.function as Record<string, unknown> | undefined;
            if (fn?.name) existing.name = fn.name as string;
            if (fn?.arguments) {
              existing.arguments += fn.arguments as string;
            }
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice
          .finish_reason as ChoiceNonStreaming["finish_reason"];
      }
    }
  }

  const toolCalls: ToolCall[] = [];
  const sortedIndices = [...toolCallsMap.keys()].sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    const toolCall = toolCallsMap.get(idx)!;
    toolCalls.push({
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: toolCall.arguments },
    });
  }

  const message: ChoiceNonStreaming["message"] = {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    ...(reasoningText && { reasoning_text: reasoningText }),
    ...(reasoningOpaque && { reasoning_opaque: reasoningOpaque }),
  };

  const result: ChatCompletionResponse = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    ...(lastUsage && { usage: lastUsage }),
  };

  return result;
}

// ── Responses SSE → ResponsesResult ──

export async function reassembleResponsesSSE(
  body: ReadableStream<Uint8Array>,
): Promise<ResponsesResult> {
  for await (const raw of parseSSEStream(body)) {
    if (!raw.data) continue;
    const trimmed = raw.data.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const type = (event.type as string) || (raw.event as string);

    if (type === "error") {
      const message = (event.message as string) ?? JSON.stringify(event);
      throw new Error(`Upstream SSE error: ${message}`);
    }

    if (
      type === "response.completed" || type === "response.incomplete" ||
      type === "response.failed"
    ) {
      return event.response as ResponsesResult;
    }
  }

  throw new Error("SSE stream ended without a terminal response event");
}
