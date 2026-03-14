import { assertEquals, assertExists } from "@std/assert";
import { translateMessagesToChatCompletion } from "./messages-to-chat.ts";
import type { AnthropicResponse, AnthropicAssistantContentBlock } from "../anthropic-types.ts";

// ── Helpers ──

function mkResponse(overrides: Partial<AnthropicResponse> = {}): AnthropicResponse {
  return {
    id: "msg_test123",
    type: "message",
    role: "assistant",
    content: [],
    model: "claude-sonnet-4-20250514",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

// ── Basic structure ──

Deno.test("response has correct shape", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [{ type: "text", text: "Hello!" }],
  }));
  assertEquals(result.id, "msg_test123");
  assertEquals(result.object, "chat.completion");
  assertEquals(result.model, "claude-sonnet-4-20250514");
  assertEquals(typeof result.created, "number");
  assertEquals(result.choices.length, 1);
  assertEquals(result.choices[0].index, 0);
  assertEquals(result.choices[0].message.role, "assistant");
});

// ── Text content ──

Deno.test("single text block → content string", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [{ type: "text", text: "Hello world" }],
  }));
  assertEquals(result.choices[0].message.content, "Hello world");
});

Deno.test("multiple text blocks concatenated", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ],
  }));
  assertEquals(result.choices[0].message.content, "Hello world");
});

Deno.test("no text blocks → content null", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [{ type: "tool_use", id: "tc1", name: "f", input: {} }],
    stop_reason: "tool_use",
  }));
  assertEquals(result.choices[0].message.content, null);
});

Deno.test("empty text block → empty string content", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [{ type: "text", text: "" }],
  }));
  // Empty string is falsy, should become null
  assertEquals(result.choices[0].message.content, null);
});

Deno.test("empty content array → content null", () => {
  const result = translateMessagesToChatCompletion(mkResponse({ content: [] }));
  assertEquals(result.choices[0].message.content, null);
});

// ── Tool calls ──

Deno.test("tool_use blocks → tool_calls", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Tokyo" } },
    ],
    stop_reason: "tool_use",
  }));
  const tc = result.choices[0].message.tool_calls;
  assertExists(tc);
  assertEquals(tc!.length, 1);
  assertEquals(tc![0].id, "tu_1");
  assertEquals(tc![0].type, "function");
  assertEquals(tc![0].function.name, "get_weather");
  assertEquals(tc![0].function.arguments, '{"city":"Tokyo"}');
});

Deno.test("multiple tool_use blocks → multiple tool_calls", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "tool_use", id: "tu_1", name: "f1", input: { a: 1 } },
      { type: "tool_use", id: "tu_2", name: "f2", input: { b: 2 } },
    ],
    stop_reason: "tool_use",
  }));
  const tc = result.choices[0].message.tool_calls;
  assertEquals(tc!.length, 2);
  assertEquals(tc![0].id, "tu_1");
  assertEquals(tc![1].id, "tu_2");
});

Deno.test("text + tool_use → both content and tool_calls", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "test" } },
    ],
    stop_reason: "tool_use",
  }));
  assertEquals(result.choices[0].message.content, "Let me check.");
  assertEquals(result.choices[0].message.tool_calls!.length, 1);
});

Deno.test("no tool_use → tool_calls not set", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [{ type: "text", text: "Hi" }],
  }));
  assertEquals(result.choices[0].message.tool_calls, undefined);
});

Deno.test("tool_use with complex nested input serialized correctly", () => {
  const input = { filters: [{ key: "status", values: ["active", "pending"] }], limit: 10 };
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [{ type: "tool_use", id: "tu_1", name: "query", input }],
    stop_reason: "tool_use",
  }));
  assertEquals(result.choices[0].message.tool_calls![0].function.arguments, JSON.stringify(input));
});

Deno.test("tool_use with empty input → empty object JSON", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [{ type: "tool_use", id: "tu_1", name: "noop", input: {} }],
    stop_reason: "tool_use",
  }));
  assertEquals(result.choices[0].message.tool_calls![0].function.arguments, "{}");
});

// ── Thinking ──

Deno.test("thinking block → reasoning_text + reasoning_opaque", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "thinking", thinking: "Let me analyze...", signature: "sig_abc" },
      { type: "text", text: "Here's my answer." },
    ],
  }));
  assertEquals(result.choices[0].message.reasoning_text, "Let me analyze...");
  assertEquals(result.choices[0].message.reasoning_opaque, "sig_abc");
  assertEquals(result.choices[0].message.content, "Here's my answer.");
});

Deno.test("thinking block without signature → only reasoning_text", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "thinking", thinking: "thoughts" },
      { type: "text", text: "answer" },
    ],
  }));
  assertEquals(result.choices[0].message.reasoning_text, "thoughts");
  assertEquals(result.choices[0].message.reasoning_opaque, undefined);
});

Deno.test("redacted_thinking block → only reasoning_opaque", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "redacted_thinking", data: "opaque_data_xyz" } as AnthropicAssistantContentBlock,
      { type: "text", text: "answer" },
    ],
  }));
  assertEquals(result.choices[0].message.reasoning_text, undefined);
  assertEquals(result.choices[0].message.reasoning_opaque, "opaque_data_xyz");
});

Deno.test("thinking takes priority over redacted_thinking", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "thinking", thinking: "My thoughts", signature: "sig1" },
      { type: "redacted_thinking", data: "should_be_ignored" } as AnthropicAssistantContentBlock,
      { type: "text", text: "answer" },
    ],
  }));
  assertEquals(result.choices[0].message.reasoning_text, "My thoughts");
  assertEquals(result.choices[0].message.reasoning_opaque, "sig1");
});

Deno.test("no thinking blocks → no reasoning fields", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [{ type: "text", text: "answer" }],
  }));
  assertEquals(result.choices[0].message.reasoning_text, undefined);
  assertEquals(result.choices[0].message.reasoning_opaque, undefined);
});

Deno.test("thinking + tool_use (interleaved thinking)", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "thinking", thinking: "I should call the tool", signature: "sig" },
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
    ],
    stop_reason: "tool_use",
  }));
  assertEquals(result.choices[0].message.reasoning_text, "I should call the tool");
  assertEquals(result.choices[0].message.reasoning_opaque, "sig");
  assertEquals(result.choices[0].message.tool_calls!.length, 1);
  assertEquals(result.choices[0].message.content, null);
});

// ── Stop reason mapping ──

Deno.test("stop_reason end_turn → stop", () => {
  const result = translateMessagesToChatCompletion(mkResponse({ stop_reason: "end_turn" }));
  assertEquals(result.choices[0].finish_reason, "stop");
});

Deno.test("stop_reason max_tokens → length", () => {
  const result = translateMessagesToChatCompletion(mkResponse({ stop_reason: "max_tokens" }));
  assertEquals(result.choices[0].finish_reason, "length");
});

Deno.test("stop_reason stop_sequence → stop", () => {
  const result = translateMessagesToChatCompletion(mkResponse({ stop_reason: "stop_sequence" }));
  assertEquals(result.choices[0].finish_reason, "stop");
});

Deno.test("stop_reason tool_use → tool_calls", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [{ type: "tool_use", id: "tu_1", name: "f", input: {} }],
    stop_reason: "tool_use",
  }));
  assertEquals(result.choices[0].finish_reason, "tool_calls");
});

Deno.test("stop_reason pause_turn → stop", () => {
  const result = translateMessagesToChatCompletion(mkResponse({ stop_reason: "pause_turn" }));
  assertEquals(result.choices[0].finish_reason, "stop");
});

Deno.test("stop_reason refusal → stop", () => {
  const result = translateMessagesToChatCompletion(mkResponse({ stop_reason: "refusal" }));
  assertEquals(result.choices[0].finish_reason, "stop");
});

Deno.test("stop_reason null → stop", () => {
  const result = translateMessagesToChatCompletion(mkResponse({ stop_reason: null }));
  assertEquals(result.choices[0].finish_reason, "stop");
});

// ── Usage mapping ──

Deno.test("basic usage mapping", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    usage: { input_tokens: 100, output_tokens: 50 },
  }));
  assertEquals(result.usage!.prompt_tokens, 100);
  assertEquals(result.usage!.completion_tokens, 50);
  assertEquals(result.usage!.total_tokens, 150);
});

Deno.test("usage with cache_read_input_tokens", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    usage: { input_tokens: 80, output_tokens: 50, cache_read_input_tokens: 20 },
  }));
  // prompt_tokens = input_tokens + cache_read_input_tokens
  assertEquals(result.usage!.prompt_tokens, 100);
  assertEquals(result.usage!.completion_tokens, 50);
  assertEquals(result.usage!.total_tokens, 150);
  assertEquals(result.usage!.prompt_tokens_details!.cached_tokens, 20);
});

Deno.test("usage without cache → no prompt_tokens_details", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    usage: { input_tokens: 100, output_tokens: 50 },
  }));
  assertEquals(result.usage!.prompt_tokens_details, undefined);
});

Deno.test("usage with cache_read_input_tokens = 0 → prompt_tokens_details present", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
  }));
  assertEquals(result.usage!.prompt_tokens, 100);
  assertEquals(result.usage!.prompt_tokens_details!.cached_tokens, 0);
});

// ── ID / model passthrough ──

Deno.test("id passed through", () => {
  const result = translateMessagesToChatCompletion(mkResponse({ id: "msg_custom_id" }));
  assertEquals(result.id, "msg_custom_id");
});

Deno.test("model passed through", () => {
  const result = translateMessagesToChatCompletion(mkResponse({ model: "claude-opus-4-20250514" }));
  assertEquals(result.model, "claude-opus-4-20250514");
});

// ── Complex combined scenarios ──

Deno.test("thinking + text + tool_use all present", () => {
  const result = translateMessagesToChatCompletion(mkResponse({
    content: [
      { type: "thinking", thinking: "thoughts", signature: "sig" },
      { type: "text", text: "Calling tool." },
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
    ],
    stop_reason: "tool_use",
  }));
  assertEquals(result.choices[0].message.reasoning_text, "thoughts");
  assertEquals(result.choices[0].message.reasoning_opaque, "sig");
  assertEquals(result.choices[0].message.content, "Calling tool.");
  assertEquals(result.choices[0].message.tool_calls!.length, 1);
  assertEquals(result.choices[0].finish_reason, "tool_calls");
});
