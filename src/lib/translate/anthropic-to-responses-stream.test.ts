import { describe, it, expect } from "vitest";
import {
  createAnthropicToResponsesStreamState,
  translateAnthropicEventToResponsesEvents,
} from "./anthropic-to-responses-stream.ts";
import type { AnthropicStreamEventData } from "../anthropic-types.ts";
import type { ResponsesResult } from "../responses-types.ts";

/**
 * Helper: run a full message lifecycle and return the completed response from the final event.
 */
function runStreamToCompletion(opts: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): ResponsesResult {
  const state = createAnthropicToResponsesStreamState("resp_test", "claude-sonnet-4-20250514");

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
  translateAnthropicEventToResponsesEvents(messageStart, state);

  // text content block
  translateAnthropicEventToResponsesEvents(
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    state,
  );
  translateAnthropicEventToResponsesEvents(
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    state,
  );
  translateAnthropicEventToResponsesEvents(
    { type: "content_block_stop", index: 0 },
    state,
  );

  // message_delta with output tokens
  translateAnthropicEventToResponsesEvents(
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: opts.output_tokens } },
    state,
  );

  // message_stop → response.completed
  const stopEvents = translateAnthropicEventToResponsesEvents(
    { type: "message_stop" },
    state,
  );

  const completedEvent = stopEvents.find((e) => e.type === "response.completed");
  if (!completedEvent || completedEvent.type !== "response.completed") {
    throw new Error("Expected response.completed event");
  }
  return completedEvent.response;
}

describe("anthropic-to-responses-stream: cache_creation_input_tokens in usage", () => {
  it("includes cache_creation_input_tokens in input_tokens", () => {
    const result = runStreamToCompletion({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    });

    // input_tokens = 100 + 20 + 30 = 150
    expect(result.usage!.input_tokens).toBe(150);
    expect(result.usage!.output_tokens).toBe(50);
    expect(result.usage!.total_tokens).toBe(200);
  });

  it("handles cache_creation_input_tokens = 0 with no effect", () => {
    const result = runStreamToCompletion({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 0,
    });

    // input_tokens = 100 + 20 + 0 = 120
    expect(result.usage!.input_tokens).toBe(120);
    expect(result.usage!.total_tokens).toBe(170);
  });

  it("handles cache_creation_input_tokens undefined (backward compat)", () => {
    const result = runStreamToCompletion({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      // cache_creation_input_tokens is undefined
    });

    // input_tokens = 100 + 20 + 0 = 120
    expect(result.usage!.input_tokens).toBe(120);
    expect(result.usage!.total_tokens).toBe(170);
  });

  it("includes input_tokens_details.cached_tokens when cache_read is present", () => {
    const result = runStreamToCompletion({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    });

    expect(result.usage!.input_tokens_details).toEqual({ cached_tokens: 20 });
  });

  it("omits input_tokens_details when cache_read is undefined", () => {
    const result = runStreamToCompletion({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 30,
    });

    // input_tokens = 100 + 0 + 30 = 130
    expect(result.usage!.input_tokens).toBe(130);
    expect(result.usage!.input_tokens_details).toBeUndefined();
  });
});
