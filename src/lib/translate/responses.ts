import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
  AnthropicTool,
} from "../anthropic-types.ts";
import { THINKING_PLACEHOLDER } from "../anthropic-types.ts";

import type {
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputText,
  ResponseOutputContentBlock,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputReasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponseTool,
  ResponseToolChoice,
} from "../responses-types.ts";
import { decodeSignature, isResponsesOriginSignature, safeJsonParse } from "./utils.ts";

// ── Request: Anthropic → Responses ──

function mapReasoningEffort(
  payload: AnthropicMessagesPayload,
): "low" | "medium" | "high" {
  if (payload.output_config?.effort) {
    const effort = payload.output_config.effort;
    if (effort === "max") return "high";
    if (effort === "low" || effort === "medium" || effort === "high") return effort;
  }
  if (payload.thinking?.budget_tokens) {
    const budget = payload.thinking.budget_tokens;
    if (budget <= 2048) return "low";
    if (budget <= 8192) return "medium";
    return "high";
  }
  return "high";
}

export function translateAnthropicToResponses(
  payload: AnthropicMessagesPayload,
): ResponsesPayload {
  return {
    model: payload.model,
    input: typeof payload.messages === "undefined" || payload.messages.length === 0
      ? []
      : payload.messages.flatMap((m) => translateMessage(m, payload.model)),
    instructions: translateSystemPrompt(payload.system),
    temperature: 1, // reasoning models use temperature 1
    top_p: payload.top_p ?? null,
    max_output_tokens: Math.max(payload.max_tokens, 12800),
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    metadata: payload.metadata ? { ...payload.metadata } : null,
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: mapReasoningEffort(payload), summary: "detailed" },
    include: ["reasoning.encrypted_content"],
  };
}

function translateMessage(msg: AnthropicMessage, model: string): ResponseInputItem[] {
  return msg.role === "user" ? translateUserMessage(msg) : translateAssistantMessage(msg, model);
}

function translateUserMessage(msg: AnthropicUserMessage): ResponseInputItem[] {
  if (typeof msg.content === "string") {
    return [{ type: "message", role: "user", content: msg.content }];
  }
  if (!Array.isArray(msg.content)) return [];

  const items: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];

  for (const block of msg.content) {
    if (block.type === "tool_result") {
      flushPendingContent(pendingContent, items, "user");
      items.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        status: block.is_error ? "incomplete" : "completed",
      });
      continue;
    }
    const converted = translateUserContentBlock(block);
    if (converted) pendingContent.push(converted);
  }

  flushPendingContent(pendingContent, items, "user");
  return items;
}

function translateAssistantMessage(msg: AnthropicAssistantMessage, _model: string): ResponseInputItem[] {
  if (typeof msg.content === "string") {
    return [{ type: "message", role: "assistant", content: msg.content }];
  }
  if (!Array.isArray(msg.content)) return [];

  const items: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];

  for (const block of msg.content) {
    if (block.type === "tool_use") {
      flushPendingContent(pendingContent, items, "assistant");
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: "completed",
      });
      continue;
    }

    // Thinking blocks with "@" in signature originated from Responses API
    if (block.type === "thinking" && isResponsesOriginSignature(block.signature)) {
      flushPendingContent(pendingContent, items, "assistant");
      const { encryptedContent, reasoningId } = decodeSignature(block.signature ?? "");
      const thinking = block.thinking === THINKING_PLACEHOLDER ? "" : block.thinking;
      items.push({
        type: "reasoning",
        id: reasoningId ?? "",
        summary: thinking ? [{ type: "summary_text", text: thinking }] : [],
        encrypted_content: encryptedContent ?? "",
      });
      continue;
    }

    if (block.type === "text") {
      pendingContent.push({ type: "output_text", text: block.text });
    }
  }

  flushPendingContent(pendingContent, items, "assistant");
  return items;
}

function translateUserContentBlock(block: AnthropicUserContentBlock): ResponseInputContent | undefined {
  if (block.type === "text") return { type: "input_text", text: block.text };
  if (block.type === "image") {
    return {
      type: "input_image",
      image_url: `data:${block.source.media_type};base64,${block.source.data}`,
      detail: "auto",
    };
  }
  return undefined;
}

function flushPendingContent(
  pending: ResponseInputContent[],
  target: ResponseInputItem[],
  role: "user" | "assistant",
): void {
  if (pending.length === 0) return;
  target.push({ type: "message", role, content: [...pending] });
  pending.length = 0;
}

function translateSystemPrompt(system: string | AnthropicTextBlock[] | undefined): string | null {
  if (!system) return null;
  if (typeof system === "string") return system;
  const text = system.map((b) => b.text).join(" ");
  return text.length > 0 ? text : null;
}

function translateTools(tools?: AnthropicMessagesPayload["tools"]): ResponseTool[] | null {
  if (!tools || tools.length === 0) return null;
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    parameters: t.input_schema,
    strict: false,
    ...(t.description ? { description: t.description } : {}),
  }));
}

function translateToolChoice(choice?: AnthropicMessagesPayload["tool_choice"]): ResponseToolChoice {
  if (!choice) return "auto";
  switch (choice.type) {
    case "auto": return "auto";
    case "any": return "required";
    case "tool": return choice.name ? { type: "function", name: choice.name } : "auto";
    case "none": return "none";
    default: return "auto";
  }
}

// ── Response: Responses → Anthropic ──

export function translateResponsesToAnthropic(response: ResponsesResult): AnthropicResponse {
  const contentBlocks = mapOutputToAnthropicContent(response.output);
  const finalContent = contentBlocks.length > 0
    ? contentBlocks
    : response.output_text
      ? [{ type: "text" as const, text: response.output_text }]
      : [];

  const inputTokens = response.usage?.input_tokens ?? 0;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content: finalContent,
    model: response.model,
    stop_reason: mapResponsesStopReason(response),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens - (cachedTokens ?? 0),
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(cachedTokens !== undefined && { cache_read_input_tokens: cachedTokens }),
    },
  };
}

function mapOutputToAnthropicContent(output: ResponseOutputItem[]): AnthropicAssistantContentBlock[] {
  const blocks: AnthropicAssistantContentBlock[] = [];

  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        const thinkingText = item.summary?.length
          ? item.summary.map((s) => s.text).join("").trim()
          : THINKING_PLACEHOLDER;
        if (thinkingText.length > 0) {
          blocks.push({
            type: "thinking",
            thinking: thinkingText,
            signature: (item.encrypted_content ?? "") + "@" + item.id,
          });
        }
        break;
      }
      case "function_call": {
        if (item.name && item.call_id) {
          let input: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(item.arguments);
            input = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
              ? parsed
              : { raw_arguments: item.arguments };
          } catch {
            input = { raw_arguments: item.arguments };
          }
          blocks.push({ type: "tool_use", id: item.call_id, name: item.name, input });
        }
        break;
      }
      case "message": {
        const text = combineMessageTextContent(item.content);
        if (text.length > 0) blocks.push({ type: "text", text });
        break;
      }
    }
  }

  return blocks;
}

function combineMessageTextContent(content: ResponseOutputContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block.type === "output_text") return block.text;
      if (block.type === "refusal") return block.refusal;
      return "";
    })
    .join("");
}

function mapResponsesStopReason(response: ResponsesResult): AnthropicResponse["stop_reason"] {
  if (response.status === "completed") {
    return response.output.some((item) => item.type === "function_call") ? "tool_use" : "end_turn";
  }
  if (response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") {
    return "max_tokens";
  }
  return null;
}

// ── Request: Responses → Anthropic (reverse translation) ──

export function translateResponsesToAnthropicPayload(payload: ResponsesPayload): AnthropicMessagesPayload {
  return {
    model: payload.model,
    messages: responsesInputToAnthropicMessages(payload.input),
    max_tokens: payload.max_output_tokens ?? 8192,
    system: payload.instructions ?? undefined,
    temperature: payload.temperature ?? undefined,
    top_p: payload.top_p ?? undefined,
    stream: payload.stream ?? undefined,
    tools: reverseTranslateTools(payload.tools),
    tool_choice: reverseTranslateToolChoice(payload.tool_choice),
    metadata: payload.metadata ? { ...payload.metadata } as { user_id?: string } : undefined,
  };
}

function responsesInputToAnthropicMessages(input: string | ResponseInputItem[]): AnthropicMessage[] {
  if (typeof input === "string") {
    return [{ role: "user" as const, content: input }];
  }

  const messages: AnthropicMessage[] = [];

  for (const item of input) {
    switch (item.type) {
      case "message": {
        if (item.role === "system" || item.role === "developer") continue;
        if (item.role === "user") messages.push(reverseUserMessage(item));
        else if (item.role === "assistant") messages.push(reverseAssistantMessage(item));
        break;
      }
      case "function_call": {
        appendToAssistant(messages, {
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: safeJsonParse(item.arguments),
        });
        break;
      }
      case "function_call_output": {
        appendToUser(messages, {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: item.output,
          is_error: item.status === "incomplete" ? true : undefined,
        });
        break;
      }
      case "reasoning": {
        const thinkingText = item.summary?.map((s) => s.text).join("") || THINKING_PLACEHOLDER;
        appendToAssistant(messages, {
          type: "thinking",
          thinking: thinkingText,
          signature: (item.encrypted_content ?? "") + "@" + item.id,
        });
        break;
      }
    }
  }

  return messages;
}

function reverseUserMessage(msg: ResponseInputMessage): AnthropicUserMessage {
  if (typeof msg.content === "string") return { role: "user", content: msg.content };
  if (!Array.isArray(msg.content)) return { role: "user", content: "" };

  const blocks: AnthropicUserContentBlock[] = [];
  for (const c of msg.content) {
    if (c.type === "input_text") {
      blocks.push({ type: "text", text: (c as ResponseInputText).text });
    } else if (c.type === "input_image") {
      const img = c as ResponseInputImage;
      const match = img.image_url.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: match[1] as AnthropicImageBlock["source"]["media_type"],
            data: match[2],
          },
        });
      }
    }
  }

  return { role: "user", content: blocks.length > 0 ? blocks : "" };
}

function reverseAssistantMessage(msg: ResponseInputMessage): AnthropicAssistantMessage {
  if (typeof msg.content === "string") return { role: "assistant", content: msg.content };
  if (!Array.isArray(msg.content)) return { role: "assistant", content: "" };

  const blocks: AnthropicAssistantContentBlock[] = [];
  for (const c of msg.content) {
    if (c.type === "output_text") {
      blocks.push({ type: "text", text: (c as ResponseInputText).text });
    }
  }

  return { role: "assistant", content: blocks.length > 0 ? blocks : "" };
}

function appendToAssistant(messages: AnthropicMessage[], block: AnthropicAssistantContentBlock): void {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    (last.content as AnthropicAssistantContentBlock[]).push(block);
  } else {
    messages.push({ role: "assistant", content: [block] });
  }
}

function appendToUser(messages: AnthropicMessage[], block: AnthropicToolResultBlock): void {
  const last = messages[messages.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) {
    (last.content as AnthropicUserContentBlock[]).push(block);
  } else {
    messages.push({ role: "user", content: [block] });
  }
}

function reverseTranslateTools(tools: ResponseTool[] | null): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function reverseTranslateToolChoice(choice?: ResponseToolChoice): AnthropicMessagesPayload["tool_choice"] {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    switch (choice) {
      case "auto": return { type: "auto" };
      case "none": return { type: "none" };
      case "required": return { type: "any" };
      default: return undefined;
    }
  }
  if (choice.type === "function" && choice.name) return { type: "tool", name: choice.name };
  return undefined;
}

// ── Response: Anthropic → Responses (reverse translation) ──

export function translateAnthropicToResponsesResult(response: AnthropicResponse): ResponsesResult {
  const output: ResponseOutputItem[] = [];
  let outputText = "";

  for (const block of response.content) {
    switch (block.type) {
      case "thinking": {
        const parts = (block.signature ?? "").split("@");
        const summaryText = block.thinking === THINKING_PLACEHOLDER ? "" : block.thinking;
        output.push({
          type: "reasoning",
          id: parts[1] ?? `reasoning_${output.length}`,
          summary: summaryText ? [{ type: "summary_text", text: summaryText }] : [],
          encrypted_content: parts[0] || undefined,
        } as ResponseOutputReasoning);
        break;
      }
      case "text": {
        outputText += block.text;
        break;
      }
      case "tool_use": {
        output.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
          status: "completed",
        } as ResponseOutputFunctionCall);
        break;
      }
    }
  }

  if (outputText.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: outputText }],
    } as ResponseOutputMessage);
  }

  const inputTokens = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0);

  return {
    id: response.id,
    object: "response",
    model: response.model,
    output,
    output_text: outputText,
    status: mapAnthropicStatus(response),
    ...(response.stop_reason === "max_tokens" && {
      incomplete_details: { reason: "max_output_tokens" },
    }),
    usage: {
      input_tokens: inputTokens,
      output_tokens: response.usage.output_tokens,
      total_tokens: inputTokens + response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens !== undefined && {
        input_tokens_details: { cached_tokens: response.usage.cache_read_input_tokens },
      }),
    },
  };
}

function mapAnthropicStatus(response: AnthropicResponse): ResponsesResult["status"] {
  return response.stop_reason === "max_tokens" ? "incomplete" : "completed";
}
