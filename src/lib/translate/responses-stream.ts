import type { AnthropicStreamEventData } from "../anthropic-types.ts";
import { THINKING_PLACEHOLDER } from "../anthropic-types.ts";
import type { ResponseOutputReasoning, ResponsesResult, ResponseStreamEvent } from "../responses-types.ts";
import { translateResponsesToAnthropic } from "./responses.ts";
import { checkWhitespaceOverflow, encodeSignature } from "./utils.ts";

export interface ResponsesStreamState {
  messageStartSent: boolean;
  messageCompleted: boolean;
  nextBlockIndex: number;
  blockIndexByKey: Map<string, number>;
  openBlocks: Set<number>;
  blockHasDelta: Set<number>;
  functionCallState: Map<number, {
    blockIndex: number;
    toolCallId: string;
    name: string;
    consecutiveWhitespace: number;
  }>;
}

export function createResponsesStreamState(): ResponsesStreamState {
  return {
    messageStartSent: false,
    messageCompleted: false,
    nextBlockIndex: 0,
    blockIndexByKey: new Map(),
    openBlocks: new Set(),
    blockHasDelta: new Set(),
    functionCallState: new Map(),
  };
}

export function translateResponsesStreamEvent(
  event: ResponseStreamEvent,
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  if (state.messageCompleted) return [];

  // deno-lint-ignore no-explicit-any
  const e = event as any;

  switch (event.type) {
    case "response.created":
      return handleResponseCreated(e.response as ResponsesResult, state);
    case "response.output_item.added":
      return handleOutputItemAdded(e, state);
    case "response.output_item.done":
      return handleOutputItemDone(e, state);
    case "response.reasoning_summary_text.delta":
      return handleThinkingDelta(e, state);
    case "response.reasoning_summary_text.done":
      return handleThinkingDone(e, state);
    case "response.output_text.delta":
      return handleTextDelta(e, state);
    case "response.output_text.done":
      return handleTextDone(e, state);
    case "response.function_call_arguments.delta":
      return handleFunctionArgsDelta(e, state);
    case "response.function_call_arguments.done":
      return handleFunctionArgsDone(e, state);
    case "response.completed":
    case "response.incomplete":
      return handleCompleted(e.response as ResponsesResult, state);
    case "response.failed":
      return handleFailed(e.response as ResponsesResult, state);
    case "error":
      return handleError(e, state);
    case "ping":
      return [{ type: "ping" }];
    default:
      return [];
  }
}

function handleResponseCreated(
  response: ResponsesResult,
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  state.messageStartSent = true;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;
  return [{
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: (response.usage?.input_tokens ?? 0) - (cachedTokens ?? 0),
        output_tokens: 0,
        ...(cachedTokens !== undefined && { cache_read_input_tokens: cachedTokens }),
      },
    },
  }];
}

function handleOutputItemAdded(
  event: { output_index: number; item: { type: string; call_id?: string; name?: string; arguments?: string } },
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  if (event.item.type !== "function_call") return [];

  const events: AnthropicStreamEventData[] = [];
  const blockIndex = state.nextBlockIndex++;
  const toolCallId = event.item.call_id ?? `tool_${blockIndex}`;
  const name = event.item.name ?? "function";

  state.functionCallState.set(event.output_index, {
    blockIndex, toolCallId, name, consecutiveWhitespace: 0,
  });

  closeOpenBlocks(state, events);
  events.push({
    type: "content_block_start",
    index: blockIndex,
    content_block: { type: "tool_use", id: toolCallId, name, input: {} },
  });
  state.openBlocks.add(blockIndex);

  if (event.item.arguments && event.item.arguments.length > 0) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: event.item.arguments },
    });
    state.blockHasDelta.add(blockIndex);
  }

  return events;
}

function handleOutputItemDone(
  event: { output_index: number; item: ResponseOutputReasoning & { type: string } },
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  if (event.item.type !== "reasoning") return [];

  const events: AnthropicStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  const signature = encodeSignature(event.item.encrypted_content ?? "", event.item.id);

  if (!event.item.summary || event.item.summary.length === 0) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "thinking_delta", thinking: THINKING_PLACEHOLDER },
    });
  }

  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "signature_delta", signature },
  });
  state.blockHasDelta.add(blockIndex);

  return events;
}

function handleThinkingDelta(
  event: { output_index: number; delta: string },
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "thinking_delta", thinking: event.delta },
  });
  state.blockHasDelta.add(blockIndex);
  return events;
}

function handleThinkingDone(
  event: { output_index: number; text: string },
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  if (event.text && !state.blockHasDelta.has(blockIndex)) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "thinking_delta", thinking: event.text },
    });
  }
  return events;
}

function handleTextDelta(
  event: { output_index: number; content_index: number; delta: string },
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  if (!event.delta) return [];
  const events: AnthropicStreamEventData[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);
  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "text_delta", text: event.delta },
  });
  state.blockHasDelta.add(blockIndex);
  return events;
}

function handleTextDone(
  event: { output_index: number; content_index: number; text: string },
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);
  if (event.text && !state.blockHasDelta.has(blockIndex)) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: event.text },
    });
  }
  return events;
}

function handleFunctionArgsDelta(
  event: { output_index: number; delta: string },
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  if (!event.delta) return [];
  const fcState = state.functionCallState.get(event.output_index);
  if (!fcState) return [];

  const events: AnthropicStreamEventData[] = [];

  const ws = checkWhitespaceOverflow(event.delta, fcState.consecutiveWhitespace);
  fcState.consecutiveWhitespace = ws.count;

  if (ws.exceeded) {
    console.warn("Infinite whitespace in Responses function call args, aborting");
    closeAllBlocks(state, events);
    state.messageCompleted = true;
    events.push({
      type: "error",
      error: { type: "api_error", message: "Tool call arguments contained excessive whitespace." },
    });
    return events;
  }

  events.push({
    type: "content_block_delta",
    index: fcState.blockIndex,
    delta: { type: "input_json_delta", partial_json: event.delta },
  });
  state.blockHasDelta.add(fcState.blockIndex);
  return events;
}

function handleFunctionArgsDone(
  event: { output_index: number; arguments?: string },
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  const fcState = state.functionCallState.get(event.output_index);
  if (!fcState) return [];

  const events: AnthropicStreamEventData[] = [];
  if (event.arguments && !state.blockHasDelta.has(fcState.blockIndex)) {
    events.push({
      type: "content_block_delta",
      index: fcState.blockIndex,
      delta: { type: "input_json_delta", partial_json: event.arguments },
    });
  }
  state.functionCallState.delete(event.output_index);
  return events;
}

function handleCompleted(
  response: ResponsesResult,
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = [];
  closeAllBlocks(state, events);

  const anthropic = translateResponsesToAnthropic(response);
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: anthropic.stop_reason, stop_sequence: anthropic.stop_sequence },
      usage: anthropic.usage,
    },
    { type: "message_stop" },
  );
  state.messageCompleted = true;
  return events;
}

function handleFailed(
  response: ResponsesResult,
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = [];
  closeAllBlocks(state, events);
  events.push({
    type: "error",
    error: { type: "api_error", message: response.error?.message ?? "Response failed due to unknown error." },
  });
  state.messageCompleted = true;
  return events;
}

function handleError(
  event: { message: string },
  state: ResponsesStreamState,
): AnthropicStreamEventData[] {
  state.messageCompleted = true;
  return [{
    type: "error",
    error: {
      type: "api_error",
      message: typeof event.message === "string" ? event.message : "An unexpected error occurred during streaming.",
    },
  }];
}

// ── Block management ──

type ContentBlockInit =
  | { type: "text"; text: "" }
  | { type: "thinking"; thinking: "" };

function openBlock(
  state: ResponsesStreamState,
  key: string,
  contentBlock: ContentBlockInit,
  events: AnthropicStreamEventData[],
): number {
  let idx = state.blockIndexByKey.get(key);
  if (idx === undefined) {
    idx = state.nextBlockIndex++;
    state.blockIndexByKey.set(key, idx);
  }
  if (!state.openBlocks.has(idx)) {
    closeOpenBlocks(state, events);
    events.push({ type: "content_block_start", index: idx, content_block: contentBlock });
    state.openBlocks.add(idx);
  }
  return idx;
}

function openTextBlock(
  state: ResponsesStreamState,
  outputIndex: number,
  contentIndex: number,
  events: AnthropicStreamEventData[],
): number {
  return openBlock(state, `${outputIndex}:${contentIndex}`, { type: "text", text: "" }, events);
}

function openThinkingBlock(
  state: ResponsesStreamState,
  outputIndex: number,
  events: AnthropicStreamEventData[],
): number {
  return openBlock(state, `${outputIndex}:0`, { type: "thinking", thinking: "" }, events);
}

function closeOpenBlocks(state: ResponsesStreamState, events: AnthropicStreamEventData[]): void {
  for (const idx of state.openBlocks) {
    events.push({ type: "content_block_stop", index: idx });
  }
  state.openBlocks.clear();
  state.blockHasDelta.clear();
}

function closeAllBlocks(state: ResponsesStreamState, events: AnthropicStreamEventData[]): void {
  closeOpenBlocks(state, events);
  state.functionCallState.clear();
}
