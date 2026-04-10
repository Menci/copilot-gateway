import { describe, it, expect } from "vitest";
import {
  createChatStreamState,
  translateAnthropicEventToChatChunks,
} from "./messages-to-chat-stream.ts";
import type { AnthropicStreamEventData } from "../anthropic-types.ts";

/**
 * Helper: run a full message lifecycle (message_start → text block → message_delta → message_stop)
 * and return the chunk that contains usage information.
 */
function runStreamWithUsage(opts: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}) {
  const state = createChatStreamState();

  const messageStart: AnthropicStreamEventData = {
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-20250514",
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: opts.input_tokens,
        output_tokens: 0,
        cache_read_input_tokens: opts.cache_read_input_tokens,
        cache_creation_input_tokens: opts.cache_creation_input_tokens,
      },
    },
  };
  translateAnthropicEventToChatChunks(messageStart, state);

  // content_block_start for text
  translateAnthropicEventToChatChunks(
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    state,
  );

  // text delta
  translateAnthropicEventToChatChunks(
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    state,
  );

  // content_block_stop
  translateAnthropicEventToChatChunks(
    { type: "content_block_stop", index: 0 },
    state,
  );

  // message_delta with usage
  const messageDelta: AnthropicStreamEventData = {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: opts.output_tokens },
  };
  const deltaChunks = translateAnthropicEventToChatChunks(messageDelta, state);
  if (deltaChunks === "DONE") throw new Error("Unexpected DONE");

  return deltaChunks[0];
}

describe("messages-to-chat-stream: cache_creation_input_tokens in prompt_tokens", () => {
  it("includes cache_creation_input_tokens in prompt_tokens", () => {
    const chunk = runStreamWithUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    });

    // prompt_tokens = input_tokens(100) + cache_read(20) + cache_creation(30) = 150
    expect(chunk.usage).toBeDefined();
    expect(chunk.usage!.prompt_tokens).toBe(150);
    expect(chunk.usage!.completion_tokens).toBe(50);
    expect(chunk.usage!.total_tokens).toBe(200);
  });

  it("handles cache_creation_input_tokens = 0 with no effect", () => {
    const chunk = runStreamWithUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 0,
    });

    // prompt_tokens = 100 + 20 + 0 = 120
    expect(chunk.usage!.prompt_tokens).toBe(120);
    expect(chunk.usage!.total_tokens).toBe(170);
  });

  it("handles cache_creation_input_tokens undefined (backward compat)", () => {
    const chunk = runStreamWithUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      // cache_creation_input_tokens is undefined
    });

    // prompt_tokens = 100 + 20 + 0 (defaults to 0) = 120
    expect(chunk.usage!.prompt_tokens).toBe(120);
    expect(chunk.usage!.total_tokens).toBe(170);
  });

  it("includes prompt_tokens_details.cached_tokens when cache_read > 0", () => {
    const chunk = runStreamWithUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    });

    expect(chunk.usage!.prompt_tokens_details).toEqual({ cached_tokens: 20 });
  });

  it("omits prompt_tokens_details when cache_read is 0", () => {
    const chunk = runStreamWithUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 30,
    });

    // prompt_tokens = 100 + 0 + 30 = 130
    expect(chunk.usage!.prompt_tokens).toBe(130);
    expect(chunk.usage!.prompt_tokens_details).toBeUndefined();
  });
});
