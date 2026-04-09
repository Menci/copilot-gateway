import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
} from "../anthropic-types.ts";
import { THINKING_PLACEHOLDER } from "../anthropic-types.ts";
import { safeJsonParse } from "./utils.ts";

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "../openai-types.ts";

// ── Shared helpers (used by openai-stream.ts too) ──

export function toAnthropicId(id: string): string {
  if (id.startsWith("msg_")) return id;
  return `msg_${id.replace(/^chatcmpl-/, "")}`;
}

export function mapStopReason(
  reason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (reason === null) return null;
  const map = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "refusal",
  } as const;
  return map[reason];
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export const mapOpenAIUsage = (
  usage?: OpenAIUsage,
): AnthropicResponse["usage"] => {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  return {
    input_tokens: (usage?.prompt_tokens ?? 0) - (cachedTokens ?? 0),
    output_tokens: usage?.completion_tokens ?? 0,
    ...(cachedTokens !== undefined && {
      cache_read_input_tokens: cachedTokens,
    }),
  };
};

// ── Request: Anthropic → OpenAI ──

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  options: { allowThinkingBudget?: boolean } = {},
): ChatCompletionsPayload {
  mergeToolResultBlocks(payload);

  const result: ChatCompletionsPayload = {
    model: payload.model,
    messages: translateMessages(payload.messages, payload.system),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    ...(payload.stream ? { stream_options: { include_usage: true } } : {}),
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
  };

  if (
    options.allowThinkingBudget !== false && payload.thinking?.budget_tokens
  ) {
    result.thinking_budget = payload.thinking.budget_tokens;
  }

  return result;
}

/**
 * Merge adjacent text blocks into tool_result blocks in user messages.
 * Reduces premium request consumption caused by skill invocations, edit hooks, etc.
 */
function mergeToolResultBlocks(payload: AnthropicMessagesPayload): void {
  for (const msg of payload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    const toolResults: AnthropicToolResultBlock[] = [];
    const textBlocks: AnthropicTextBlock[] = [];
    let valid = true;

    for (const block of msg.content) {
      if (block.type === "tool_result") toolResults.push(block);
      else if (block.type === "text") textBlocks.push(block);
      else {
        valid = false;
        break;
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue;

    const lastTR = toolResults[toolResults.length - 1];
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n");
    lastTR.content = `${lastTR.content ?? ""}\n\n${appendedTexts}`;
    msg.content = toolResults;
  }
}

function translateMessages(
  msgs: AnthropicMessage[],
  system: string | AnthropicTextBlock[] | undefined,
): Message[] {
  const systemMsgs: Message[] = system
    ? [{
      role: "system",
      content: typeof system === "string"
        ? system
        : system.map((b) => b.text).join("\n\n"),
    }]
    : [];

  return [
    ...systemMsgs,
    ...msgs.flatMap((m) =>
      m.role === "user" ? handleUser(m) : handleAssistant(m)
    ),
  ];
}

function handleUser(msg: AnthropicUserMessage): Message[] {
  if (!Array.isArray(msg.content)) {
    return [{ role: "user", content: mapContent(msg.content) }];
  }

  const result: Message[] = [];
  const toolResults = msg.content.filter((b): b is AnthropicToolResultBlock =>
    b.type === "tool_result"
  );
  const others = msg.content.filter((b) => b.type !== "tool_result");

  for (const tr of toolResults) {
    result.push({
      role: "tool",
      tool_call_id: tr.tool_use_id,
      content: mapContent(tr.content),
    });
  }
  if (others.length > 0) {
    result.push({ role: "user", content: mapContent(others) });
  }
  return result;
}

function handleAssistant(msg: AnthropicAssistantMessage): Message[] {
  if (!Array.isArray(msg.content)) {
    return [{ role: "assistant", content: mapContent(msg.content) }];
  }

  const toolUses = msg.content.filter((b): b is AnthropicToolUseBlock =>
    b.type === "tool_use"
  );
  const texts = msg.content.filter((b): b is AnthropicTextBlock =>
    b.type === "text"
  );
  const thinking = msg.content.filter((b): b is AnthropicThinkingBlock =>
    b.type === "thinking"
  );

  const textContent = texts.map((b) => b.text).join("\n\n");
  const reasoningText = thinking.map((b) => b.thinking).join("\n\n") || null;
  const reasoningOpaque = thinking.find((b) => b.signature)?.signature ?? null;

  const base = {
    role: "assistant" as const,
    content: textContent || null,
    reasoning_text: reasoningText,
    reasoning_opaque: reasoningOpaque,
  };

  if (toolUses.length > 0) {
    return [{
      ...base,
      tool_calls: toolUses.map((tu) => ({
        id: tu.id,
        type: "function" as const,
        function: { name: tu.name, arguments: JSON.stringify(tu.input) },
      })),
    }];
  }

  return [base];
}

function mapContent(
  content:
    | string
    | (AnthropicUserContentBlock | AnthropicAssistantContentBlock)[],
): string | ContentPart[] | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  if (!content.some((b) => b.type === "image")) {
    return content
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
  }

  const parts: ContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      });
    }
  }
  return parts;
}

function translateTools(
  tools?: AnthropicMessagesPayload["tools"],
): Tool[] | undefined {
  if (!tools) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    },
  }));
}

function translateToolChoice(
  tc?: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!tc) return undefined;
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return tc.name
        ? { type: "function", function: { name: tc.name } }
        : undefined;
    case "none":
      return "none";
    default:
      return undefined;
  }
}

// ── Response: OpenAI → Anthropic ──

function getThinkingBlocks(
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
): AnthropicThinkingBlock[] {
  if (reasoningText && reasoningText.length > 0) {
    return [{
      type: "thinking",
      thinking: reasoningText,
      signature: reasoningOpaque ?? "",
    }];
  }
  if (reasoningOpaque && reasoningOpaque.length > 0) {
    return [{
      type: "thinking",
      thinking: THINKING_PLACEHOLDER,
      signature: reasoningOpaque,
    }];
  }
  return [];
}

export function translateToAnthropic(
  resp: ChatCompletionResponse,
): AnthropicResponse {
  const allThinkingBlocks: AnthropicThinkingBlock[] = [];
  const allTextBlocks: AnthropicTextBlock[] = [];
  const allToolBlocks: AnthropicToolUseBlock[] = [];
  let stopReason = resp.choices[0]?.finish_reason ?? null;

  for (const choice of resp.choices) {
    allThinkingBlocks.push(
      ...getThinkingBlocks(
        choice.message.reasoning_text,
        choice.message.reasoning_opaque,
      ),
    );

    if (choice.message.content) {
      allTextBlocks.push({ type: "text", text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        const input = safeJsonParse(tc.function.arguments);
        allToolBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason;
    }
  }

  return {
    id: toAnthropicId(resp.id),
    type: "message",
    role: "assistant",
    model: resp.model,
    content: [...allThinkingBlocks, ...allTextBlocks, ...allToolBlocks],
    stop_reason: mapStopReason(stopReason),
    stop_sequence: null,
    usage: mapOpenAIUsage(resp.usage),
  };
}
