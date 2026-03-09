import type {
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "./anthropic-types.ts";
import { THINKING_PLACEHOLDER } from "./anthropic-types.ts";
import type { ChatCompletionChunk } from "./openai-types.ts";
import { mapStopReason } from "./stop-reason.ts";
import { mapOpenAIUsage } from "./usage.ts";
import { toAnthropicId } from "./translate.ts";

const MAX_CONSECUTIVE_WHITESPACE = 20;

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

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): AnthropicStreamEventData[] {
  const events: AnthropicStreamEventData[] = [];

  if (chunk.choices.length === 0 || state.aborted) return events;

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

  // reasoning_text → thinking block
  if (delta.reasoning_text) {
    if (!state.thinkingBlockOpen) {
      if (state.contentBlockOpen) {
        events.push({ type: "content_block_stop", index: state.contentBlockIndex });
        state.contentBlockIndex++;
        state.contentBlockOpen = false;
      }
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
      state.contentBlockOpen = true;
      state.thinkingBlockOpen = true;
      state.thinkingHasContent = true;
    }
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "thinking_delta", thinking: delta.reasoning_text },
    });
  }

  // reasoning_opaque → signature delta
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

  if (delta.content) {
    closeThinkingBlock(state, events);

    if (isToolBlockOpen(state)) {
      events.push({ type: "content_block_stop", index: state.contentBlockIndex });
      state.contentBlockIndex++;
      state.contentBlockOpen = false;
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
      delta: { type: "text_delta", text: delta.content },
    });
  }

  if (delta.tool_calls) {
    closeThinkingBlock(state, events);

    for (const tc of delta.tool_calls) {
      if (tc.id && tc.function?.name) {
        if (state.contentBlockOpen) {
          events.push({ type: "content_block_stop", index: state.contentBlockIndex });
          state.contentBlockIndex++;
          state.contentBlockOpen = false;
        }
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
          // Detect infinite whitespace in function call arguments
          const args = tc.function.arguments;
          let wsCount = info.consecutiveWhitespace;
          let exceeded = false;
          for (const ch of args) {
            if (ch === "\r" || ch === "\n" || ch === "\t") {
              wsCount++;
              if (wsCount > MAX_CONSECUTIVE_WHITESPACE) { exceeded = true; break; }
            } else if (ch !== " ") {
              wsCount = 0;
            }
          }
          info.consecutiveWhitespace = wsCount;

          if (exceeded) {
            console.warn("Infinite whitespace detected in tool call arguments, aborting stream");
            state.aborted = true;
            if (state.contentBlockOpen) {
              events.push({ type: "content_block_stop", index: state.contentBlockIndex });
              state.contentBlockOpen = false;
            }
            events.push({
              type: "error",
              error: { type: "api_error", message: "Tool call arguments contained excessive whitespace, indicating a degenerate response." },
            });
            return events;
          }

          events.push({
            type: "content_block_delta",
            index: info.anthropicBlockIndex,
            delta: { type: "input_json_delta", partial_json: args },
          });
        }
      }
    }
  }

  if (choice.finish_reason) {
    closeThinkingBlock(state, events);

    // Emit pending opaque-only reasoning as a complete thinking block
    if (state.pendingReasoningOpaque && !state.thinkingHasContent) {
      events.push(
        { type: "content_block_start", index: state.contentBlockIndex, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: state.contentBlockIndex, delta: { type: "thinking_delta", thinking: THINKING_PLACEHOLDER } },
        { type: "content_block_delta", index: state.contentBlockIndex, delta: { type: "signature_delta", signature: state.pendingReasoningOpaque } },
        { type: "content_block_stop", index: state.contentBlockIndex },
      );
      state.contentBlockIndex++;
    }

    if (state.contentBlockOpen) {
      events.push({ type: "content_block_stop", index: state.contentBlockIndex });
      state.contentBlockOpen = false;
    }
    events.push(
      {
        type: "message_delta",
        delta: { stop_reason: mapStopReason(choice.finish_reason), stop_sequence: null },
        usage: mapOpenAIUsage(chunk.usage),
      },
      { type: "message_stop" },
    );
  }

  return events;
}
