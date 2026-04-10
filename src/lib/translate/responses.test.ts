import { describe, it, expect } from "vitest";
import { translateAnthropicToResponsesResult } from "./responses.ts";
import type { AnthropicResponse } from "../anthropic-types.ts";

function makeAnthropicResponse(usage: AnthropicResponse["usage"]): AnthropicResponse {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    model: "claude-sonnet-4-20250514",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
}

describe("responses.ts: cache_creation_input_tokens in input_tokens", () => {
  it("includes cache_creation_input_tokens in input_tokens", () => {
    const response = makeAnthropicResponse({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    });

    const result = translateAnthropicToResponsesResult(response);

    // input_tokens = 100 + 20 + 30 = 150
    expect(result.usage!.input_tokens).toBe(150);
    expect(result.usage!.output_tokens).toBe(50);
    expect(result.usage!.total_tokens).toBe(200);
  });

  it("handles cache_creation_input_tokens = 0 with no effect", () => {
    const response = makeAnthropicResponse({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 0,
    });

    const result = translateAnthropicToResponsesResult(response);

    // input_tokens = 100 + 20 + 0 = 120
    expect(result.usage!.input_tokens).toBe(120);
    expect(result.usage!.total_tokens).toBe(170);
  });

  it("handles cache_creation_input_tokens undefined (backward compat)", () => {
    const response = makeAnthropicResponse({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      // cache_creation_input_tokens is undefined
    });

    const result = translateAnthropicToResponsesResult(response);

    // input_tokens = 100 + 20 + 0 = 120
    expect(result.usage!.input_tokens).toBe(120);
    expect(result.usage!.total_tokens).toBe(170);
  });

  it("includes input_tokens_details.cached_tokens when cache_read is present", () => {
    const response = makeAnthropicResponse({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    });

    const result = translateAnthropicToResponsesResult(response);

    expect(result.usage!.input_tokens_details).toEqual({ cached_tokens: 20 });
  });

  it("omits input_tokens_details when cache_read is undefined", () => {
    const response = makeAnthropicResponse({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 30,
    });

    const result = translateAnthropicToResponsesResult(response);

    // input_tokens = 100 + 0 + 30 = 130
    expect(result.usage!.input_tokens).toBe(130);
    expect(result.usage!.input_tokens_details).toBeUndefined();
  });
});
