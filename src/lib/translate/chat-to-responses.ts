// Direct Chat Completions ↔ Responses translation (no Anthropic intermediate)

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Delta,
  Tool,
  ToolCall,
} from "../openai-types.ts";
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputReasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseTool,
  ResponseToolChoice,
} from "../responses-types.ts";
import {
  makeResponsesReasoningId,
  type ResponsesReasoningEffort,
} from "../reasoning.ts";

// ── Request: Chat Completions → Responses ──

export function translateChatToResponses(
  payload: ChatCompletionsPayload,
  options: { reasoningEffort?: ResponsesReasoningEffort | null } = {},
): ResponsesPayload {
  const instructions: string[] = [];
  const input: ResponseInputItem[] = [];

  for (const msg of payload.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = extractTextContent(msg.content);
      if (text) instructions.push(text);
      continue;
    }

    if (msg.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: translateContentParts(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant") {
      // Reasoning items come before the assistant message
      if (msg.reasoning_opaque) {
        input.push({
          type: "reasoning",
          id: makeResponsesReasoningId(input.length),
          summary: msg.reasoning_text
            ? [{ type: "summary_text", text: msg.reasoning_text }]
            : [],
          encrypted_content: msg.reasoning_opaque,
        });
      }

      // Tool calls become separate function_call items
      if (msg.tool_calls?.length) {
        // If there's also text content, emit it as a message first
        const text = extractTextContent(msg.content);
        if (text) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          });
        }
        for (const tc of msg.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            status: "completed",
          });
        }
      } else {
        input.push({
          type: "message",
          role: "assistant",
          content: translateAssistantContent(msg.content),
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content),
      });
      continue;
    }
  }

  const result: ResponsesPayload = {
    model: payload.model,
    input,
    instructions: instructions.length > 0 ? instructions.join("\n\n") : null,
    temperature: payload.temperature ?? null,
    top_p: payload.top_p ?? null,
    max_output_tokens: payload.max_tokens ?? null,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    metadata: null,
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: true,
  };

  // Non-standard Chat Completions top-level fields are only preserved on the
  // native `/chat/completions` path. Pairwise translation only carries fields
  // with an explicit source-side contract.
  const effort = options.reasoningEffort;

  if (effort) {
    result.reasoning = { effort, summary: "detailed" };
    result.include = ["reasoning.encrypted_content"];
  }

  return result;
}

function extractTextContent(
  content: string | ContentPart[] | null,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function translateContentParts(
  content: string | ContentPart[] | null,
): string | ResponseInputContent[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: ResponseInputContent[] = [];
  for (const p of content) {
    if (p.type === "text") {
      parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "image_url") {
      parts.push({
        type: "input_image",
        image_url: p.image_url.url,
        detail: p.image_url.detail ?? "auto",
      });
    }
  }
  return parts.length > 0 ? parts : "";
}

function translateAssistantContent(
  content: string | ContentPart[] | null,
): string | ResponseInputContent[] {
  const text = extractTextContent(content);
  if (!text) return "";
  return [{ type: "output_text", text }];
}

function translateTools(
  tools?: Tool[] | null,
): ResponseTool[] | null {
  if (!tools?.length) return null;
  return tools.map((t) => ({
    type: "function" as const,
    name: t.function.name,
    parameters: t.function.parameters,
    strict: t.function.strict ?? false,
    ...(t.function.description ? { description: t.function.description } : {}),
  }));
}

function translateToolChoice(
  choice?: ChatCompletionsPayload["tool_choice"],
): ResponseToolChoice {
  if (!choice) return "auto";
  if (typeof choice === "string") {
    if (choice === "none" || choice === "auto" || choice === "required") {
      return choice;
    }
    return "auto";
  }
  if (choice.type === "function" && choice.function?.name) {
    return { type: "function", name: choice.function.name };
  }
  return "auto";
}

// ── Response: Responses → Chat Completions (non-streaming) ──

export function translateResponsesToChatCompletion(
  response: ResponsesResult,
): ChatCompletionResponse {
  let content = "";
  const toolCalls: ToolCall[] = [];
  let reasoningText: string | undefined;
  let reasoningOpaque: string | undefined;

  for (const item of response.output) {
    switch (item.type) {
      case "message": {
        for (const block of item.content) {
          if (block.type === "output_text") content += block.text;
          else if (block.type === "refusal") content += block.refusal;
        }
        break;
      }
      case "function_call": {
        toolCalls.push({
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        });
        break;
      }
      case "reasoning": {
        const text = item.summary?.map((s) => s.text).join("") ?? "";
        if (text) reasoningText = (reasoningText ?? "") + text;
        if (item.encrypted_content) {
          reasoningOpaque = (reasoningOpaque ?? "") + item.encrypted_content;
        }
        break;
      }
    }
  }

  // Fallback to output_text if no message items
  if (!content && response.output_text) {
    content = response.output_text;
  }

  const finishReason = mapFinishReason(response);
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          ...(reasoningText !== undefined && { reasoning_text: reasoningText }),
          ...(reasoningOpaque !== undefined && {
            reasoning_opaque: reasoningOpaque,
          }),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cachedTokens !== undefined && {
        prompt_tokens_details: { cached_tokens: cachedTokens },
      }),
    },
  };
}

function mapFinishReason(
  response: ResponsesResult,
): "stop" | "length" | "tool_calls" | "content_filter" {
  if (response.status === "completed") {
    return response.output.some((item) => item.type === "function_call")
      ? "tool_calls"
      : "stop";
  }
  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "length";
  }
  return "stop";
}

// ── Streaming: Responses stream → Chat Completions chunks ──

interface ResponsesToChatStreamState {
  messageId: string;
  model: string;
  created: number;
  toolCallIndex: number;
  /** Map output_index → toolCallIndex for function calls */
  functionCallIndices: Map<number, number>;
  inputTokens: number;
  cachedTokens: number;
  done: boolean;
}

export function createResponsesToChatStreamState(): ResponsesToChatStreamState {
  return {
    messageId: "",
    model: "",
    created: Math.floor(Date.now() / 1000),
    toolCallIndex: -1,
    functionCallIndices: new Map(),
    inputTokens: 0,
    cachedTokens: 0,
    done: false,
  };
}

export function translateResponsesEventToChatChunks(
  event: ResponseStreamEvent,
  state: ResponsesToChatStreamState,
): ChatCompletionChunk[] | "DONE" {
  if (state.done) return [];

  // deno-lint-ignore no-explicit-any
  const e = event as any;

  switch (event.type) {
    case "response.created": {
      const resp = e.response as ResponsesResult;
      state.messageId = resp.id;
      state.model = resp.model;
      state.inputTokens = resp.usage?.input_tokens ?? 0;
      state.cachedTokens = resp.usage?.input_tokens_details?.cached_tokens ?? 0;
      return [makeChunk(state, { role: "assistant" })];
    }

    case "response.output_item.added": {
      const item = e.item;
      if (item?.type === "function_call") {
        state.toolCallIndex++;
        state.functionCallIndices.set(e.output_index, state.toolCallIndex);
        return [
          makeChunk(state, {
            tool_calls: [
              {
                index: state.toolCallIndex,
                id: item.call_id ?? `call_${state.toolCallIndex}`,
                type: "function",
                function: {
                  name: item.name ?? "",
                  arguments: "",
                },
              },
            ],
          }),
        ];
      }
      return [];
    }

    case "response.output_item.done": {
      const item = e.item as ResponseOutputReasoning & { type: string };
      if (item.type === "reasoning" && item.encrypted_content) {
        return [
          makeChunk(state, { reasoning_opaque: item.encrypted_content }),
        ];
      }
      return [];
    }

    case "response.reasoning_summary_text.delta": {
      return [makeChunk(state, { reasoning_text: e.delta })];
    }

    case "response.output_text.delta": {
      if (!e.delta) return [];
      return [makeChunk(state, { content: e.delta })];
    }

    case "response.function_call_arguments.delta": {
      if (!e.delta) return [];
      const tcIdx = state.functionCallIndices.get(e.output_index);
      if (tcIdx === undefined) return [];
      return [
        makeChunk(state, {
          tool_calls: [
            {
              index: tcIdx,
              function: { arguments: e.delta },
            },
          ],
        }),
      ];
    }

    case "response.completed":
    case "response.incomplete": {
      const resp = e.response as ResponsesResult;
      const finishReason = mapFinishReason(resp);
      const chunk = makeChunk(state, {}, finishReason);

      if (resp.usage) {
        chunk.usage = {
          prompt_tokens: resp.usage.input_tokens,
          completion_tokens: resp.usage.output_tokens,
          total_tokens: resp.usage.total_tokens,
          ...(resp.usage.input_tokens_details?.cached_tokens !== undefined && {
            prompt_tokens_details: {
              cached_tokens: resp.usage.input_tokens_details.cached_tokens,
            },
          }),
        };
      }

      state.done = true;
      return [chunk];
    }

    case "response.failed": {
      state.done = true;
      return [];
    }

    default:
      return [];
  }
}

function makeChunk(
  state: ResponsesToChatStreamState,
  delta: Delta,
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id: state.messageId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason:
          finishReason as ChatCompletionChunk["choices"][0]["finish_reason"],
      },
    ],
  };
}
