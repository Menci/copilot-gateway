import type {
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "../anthropic-types.ts";
import { THINKING_PLACEHOLDER } from "../anthropic-types.ts";
import type { ChatCompletionChunk } from "../openai-types.ts";
import { mapStopReason, mapOpenAIUsage, toAnthropicId } from "./openai.ts";
import { checkWhitespaceOverflow } from "./utils.ts";

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) return false;
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  );
}

function closeThinkingBlock(
  state: AnthropicStreamState,
  events: AnthropicStreamEventData[],
): void {
  if (!state.thinkingBlockOpen) return;

  if (!state.thinkingSignatureSent) {
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "signature_delta", signature: "" },
    });
  }

  events.push({ type: "content_block_stop", index: state.contentBlockIndex });
  state.contentBlockIndex++;
  state.contentBlockOpen = false;
  state.thinkingBlockOpen = false;
  state.thinkingSignatureSent = false;
}

function closeCurrentBlock(
  state: AnthropicStreamState,
  events: AnthropicStreamEventData[],
): void {
  if (!state.contentBlockOpen) return;
  events.push({ type: "content_block_stop", index: state.contentBlockIndex });
  state.contentBlockIndex++;
  state.contentBlockOpen = false;
}

function handleReasoningDelta(
  delta: ChatCompletionChunk["choices"][0]["delta"],
  state: AnthropicStreamState,
  events: AnthropicStreamEventData[],
): void {
  if (delta.reasoning_text) {
    if (!state.thinkingBlockOpen) {
      closeCurrentBlock(state, events);
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
      state.contentBlockOpen = true;
      state.thinkingBlockOpen = true;
      state.thinkingHasContent = true;

      // Flush any pending opaque data into the newly opened thinking block
      if (state.pendingReasoningOpaque) {
        events.push({
          type: "content_block_delta",
          index: state.contentBlockIndex,
          delta: { type: "signature_delta", signature: state.pendingReasoningOpaque },
        });
        state.thinkingSignatureSent = true;
        state.pendingReasoningOpaque = undefined;
      }
    }
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "thinking_delta", thinking: delta.reasoning_text },
    });
  }

  if (delta.reasoning_opaque) {
    if (state.thinkingBlockOpen) {
      events.push({
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: { type: "signature_delta", signature: delta.reasoning_opaque },
      });
      state.thinkingSignatureSent = true;
    } else {
      state.pendingReasoningOpaque = (state.pendingReasoningOpaque ?? "") + delta.reasoning_opaque;
    }
  }
}

function handleContentDelta(
  content: string,
  state: AnthropicStreamState,
  events: AnthropicStreamEventData[],
): void {
  closeThinkingBlock(state, events);

  if (isToolBlockOpen(state)) {
    closeCurrentBlock(state, events);
  }
  if (!state.contentBlockOpen) {
    events.push({
      type: "content_block_start",
      index: state.contentBlockIndex,
      content_block: { type: "text", text: "" },
    });
    state.contentBlockOpen = true;
  }
  events.push({
    type: "content_block_delta",
    index: state.contentBlockIndex,
    delta: { type: "text_delta", text: content },
  });
}

function handleToolCallsDelta(
  toolCalls: NonNullable<ChatCompletionChunk["choices"][0]["delta"]["tool_calls"]>,
  state: AnthropicStreamState,
  events: AnthropicStreamEventData[],
): boolean {
  closeThinkingBlock(state, events);

  for (const tc of toolCalls) {
    if (tc.id && tc.function?.name) {
      closeCurrentBlock(state, events);
      const blockIdx = state.contentBlockIndex;
      state.toolCalls[tc.index] = {
        id: tc.id,
        name: tc.function.name,
        anthropicBlockIndex: blockIdx,
        consecutiveWhitespace: 0,
      };
      events.push({
        type: "content_block_start",
        index: blockIdx,
        content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} },
      });
      state.contentBlockOpen = true;
    }
    if (tc.function?.arguments) {
      const info = state.toolCalls[tc.index];
      if (info) {
        const ws = checkWhitespaceOverflow(tc.function.arguments, info.consecutiveWhitespace);
        info.consecutiveWhitespace = ws.count;

        if (ws.exceeded) {
          console.warn("Infinite whitespace detected in tool call arguments, aborting stream");
          state.aborted = true;
          closeCurrentBlock(state, events);
          events.push({
            type: "error",
            error: { type: "api_error", message: "Tool call arguments contained excessive whitespace, indicating a degenerate response." },
          });
          return true;
        }

        events.push({
          type: "content_block_delta",
          index: info.anthropicBlockIndex,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments },
        });
      }
    }
  }
  return false;
}

function handleFinishReason(
  finishReason: string | null,
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
  events: AnthropicStreamEventData[],
): void {
  closeThinkingBlock(state, events);

  if (state.pendingReasoningOpaque && !state.thinkingHasContent) {
    events.push(
      { type: "content_block_start", index: state.contentBlockIndex, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: state.contentBlockIndex, delta: { type: "thinking_delta", thinking: THINKING_PLACEHOLDER } },
      { type: "content_block_delta", index: state.contentBlockIndex, delta: { type: "signature_delta", signature: state.pendingReasoningOpaque } },
      { type: "content_block_stop", index: state.contentBlockIndex },
    );
    state.contentBlockIndex++;
  }

  closeCurrentBlock(state, events);

  if (chunk.usage) state.usageSent = true;

  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: mapStopReason(finishReason as Parameters<typeof mapStopReason>[0]), stop_sequence: null },
      usage: mapOpenAIUsage(chunk.usage),
    },
    { type: "message_stop" },
  );
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = [];

  // Handle usage-only chunk (choices=[], usage present) — OpenAI sends this
  // as the final chunk when stream_options.include_usage is true
  if (chunk.choices.length === 0) {
    if (!state.aborted && chunk.usage && !state.usageSent) {
      state.usageSent = true;
      events.push({
        type: "message_delta",
        delta: { stop_reason: null, stop_sequence: null },
        usage: mapOpenAIUsage(chunk.usage),
      });
    }
    return events;
  }
  if (state.aborted) return events;

  const choice = chunk.choices[0];
  const { delta } = choice;

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: toAnthropicId(chunk.id),
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: mapOpenAIUsage(chunk.usage),
      },
    });
    state.messageStartSent = true;
  }

  handleReasoningDelta(delta, state, events);

  if (delta.content) {
    handleContentDelta(delta.content, state, events);
  }

  if (delta.tool_calls) {
    const aborted = handleToolCallsDelta(delta.tool_calls, state, events);
    if (aborted) return events;
  }

  if (choice.finish_reason) {
    handleFinishReason(choice.finish_reason, chunk, state, events);
  }

  return events;
}
