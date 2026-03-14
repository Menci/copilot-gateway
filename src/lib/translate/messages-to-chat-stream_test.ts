import { assertEquals } from "@std/assert";
import {
  createChatStreamState,
  translateAnthropicEventToChatChunks,
  type ChatStreamState,
} from "./messages-to-chat-stream.ts";
import type { AnthropicStreamEventData } from "../anthropic-types.ts";
import type { ChatCompletionChunk, Delta } from "../openai-types.ts";

// ── Helpers ──

function process(events: AnthropicStreamEventData[]): (ChatCompletionChunk[] | "DONE")[] {
  const state = createChatStreamState();
  return events.map((e) => translateAnthropicEventToChatChunks(e, state));
}

function processFlat(events: AnthropicStreamEventData[]): ChatCompletionChunk[] {
  const results = process(events);
  const chunks: ChatCompletionChunk[] = [];
  for (const r of results) {
    if (r === "DONE") break;
    chunks.push(...r);
  }
  return chunks;
}

function deltas(events: AnthropicStreamEventData[]): Delta[] {
  return processFlat(events).map((c) => c.choices[0].delta);
}

const MSG_START: AnthropicStreamEventData = {
  type: "message_start",
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [],
    model: "claude-sonnet-4-20250514",
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};

// ── createChatStreamState ──

Deno.test("initial state has correct defaults", () => {
  const state = createChatStreamState();
  assertEquals(state.messageId, "");
  assertEquals(state.model, "");
  assertEquals(state.toolCallIndex, -1);
  assertEquals(state.currentBlockType, "");
  assertEquals(typeof state.created, "number");
});

// ── message_start ──

Deno.test("message_start → chunk with role:assistant", () => {
  const state = createChatStreamState();
  const result = translateAnthropicEventToChatChunks(MSG_START, state);
  assertEquals(result !== "DONE", true);
  const chunks = result as ChatCompletionChunk[];
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].choices[0].delta.role, "assistant");
  assertEquals(chunks[0].id, "msg_test");
  assertEquals(chunks[0].model, "claude-sonnet-4-20250514");
  assertEquals(chunks[0].object, "chat.completion.chunk");
});

Deno.test("message_start sets state", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  assertEquals(state.messageId, "msg_test");
  assertEquals(state.model, "claude-sonnet-4-20250514");
});

// ── content_block_start: text ──

Deno.test("text content_block_start → no output", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }, state);
  assertEquals(result, []);
});

// ── content_block_start: thinking ──

Deno.test("thinking content_block_start → no output", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  }, state);
  assertEquals(result, []);
});

// ── content_block_start: redacted_thinking ──

Deno.test("redacted_thinking content_block_start → reasoning_opaque chunk", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "content_block_start",
    index: 0,
    content_block: { type: "redacted_thinking", data: "opaque_xyz" },
  }, state);
  const chunks = result as ChatCompletionChunk[];
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].choices[0].delta.reasoning_opaque, "opaque_xyz");
});

// ── content_block_start: tool_use ──

Deno.test("tool_use content_block_start → tool_calls init chunk", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tu_1", name: "search", input: {} },
  }, state);
  const chunks = result as ChatCompletionChunk[];
  assertEquals(chunks.length, 1);
  const tc = chunks[0].choices[0].delta.tool_calls;
  assertEquals(tc!.length, 1);
  assertEquals(tc![0].index, 0);
  assertEquals(tc![0].id, "tu_1");
  assertEquals(tc![0].type, "function");
  assertEquals(tc![0].function!.name, "search");
  assertEquals(tc![0].function!.arguments, "");
});

Deno.test("multiple tool_use blocks increment index", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);

  translateAnthropicEventToChatChunks({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tu_1", name: "f1", input: {} },
  }, state);

  const result = translateAnthropicEventToChatChunks({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tu_2", name: "f2", input: {} },
  }, state);

  const tc = (result as ChatCompletionChunk[])[0].choices[0].delta.tool_calls;
  assertEquals(tc![0].index, 1);
  assertEquals(tc![0].id, "tu_2");
  assertEquals(tc![0].function!.name, "f2");
});

// ── content_block_delta: text_delta ──

Deno.test("text_delta → content delta", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  ]);
  // d[0] = role chunk, d[1] = content chunk
  assertEquals(d[1].content, "Hello");
});

Deno.test("multiple text_deltas → multiple content chunks", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
  ]);
  assertEquals(d[1].content, "Hello");
  assertEquals(d[2].content, " world");
});

// ── content_block_delta: thinking_delta ──

Deno.test("thinking_delta → reasoning_text delta", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think..." } },
  ]);
  assertEquals(d[1].reasoning_text, "Let me think...");
});

// ── content_block_delta: signature_delta ──

Deno.test("signature_delta → reasoning_opaque delta", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thoughts" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_abc" } },
  ]);
  assertEquals(d[2].reasoning_opaque, "sig_abc");
});

// ── content_block_delta: input_json_delta ──

Deno.test("input_json_delta → tool_calls arguments delta", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "f", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"ke' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'y":"val"}' } },
  ]);
  // d[0] = role, d[1] = tool init, d[2] = first json delta, d[3] = second json delta
  assertEquals(d[2].tool_calls![0].index, 0);
  assertEquals(d[2].tool_calls![0].function!.arguments, '{"ke');
  assertEquals(d[3].tool_calls![0].function!.arguments, 'y":"val"}');
});

// ── content_block_stop ──

Deno.test("content_block_stop → no output, resets block type", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  translateAnthropicEventToChatChunks({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }, state);
  assertEquals(state.currentBlockType, "text");

  const result = translateAnthropicEventToChatChunks({
    type: "content_block_stop",
    index: 0,
  }, state);
  assertEquals(result, []);
  assertEquals(state.currentBlockType, "");
});

// ── message_delta ──

Deno.test("message_delta with end_turn → finish_reason stop", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 50 },
  }, state);
  const chunks = result as ChatCompletionChunk[];
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].choices[0].finish_reason, "stop");
  assertEquals(chunks[0].usage!.completion_tokens, 50);
});

Deno.test("message_delta with tool_use → finish_reason tool_calls", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
  }, state);
  assertEquals((result as ChatCompletionChunk[])[0].choices[0].finish_reason, "tool_calls");
});

Deno.test("message_delta with max_tokens → finish_reason length", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "message_delta",
    delta: { stop_reason: "max_tokens" },
  }, state);
  assertEquals((result as ChatCompletionChunk[])[0].choices[0].finish_reason, "length");
});

Deno.test("message_delta with stop_sequence → finish_reason stop", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "message_delta",
    delta: { stop_reason: "stop_sequence" },
  }, state);
  assertEquals((result as ChatCompletionChunk[])[0].choices[0].finish_reason, "stop");
});

Deno.test("message_delta with pause_turn → finish_reason stop", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "message_delta",
    delta: { stop_reason: "pause_turn" },
  }, state);
  assertEquals((result as ChatCompletionChunk[])[0].choices[0].finish_reason, "stop");
});

Deno.test("message_delta with refusal → finish_reason stop", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "message_delta",
    delta: { stop_reason: "refusal" },
  }, state);
  assertEquals((result as ChatCompletionChunk[])[0].choices[0].finish_reason, "stop");
});

Deno.test("message_delta without usage → no usage on chunk", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
  }, state);
  assertEquals((result as ChatCompletionChunk[])[0].usage, undefined);
});

// ── message_stop ──

Deno.test("message_stop → DONE", () => {
  const state = createChatStreamState();
  translateAnthropicEventToChatChunks(MSG_START, state);
  const result = translateAnthropicEventToChatChunks({ type: "message_stop" }, state);
  assertEquals(result, "DONE");
});

// ── ping / error ──

Deno.test("ping → no output", () => {
  const state = createChatStreamState();
  const result = translateAnthropicEventToChatChunks({ type: "ping" }, state);
  assertEquals(result, []);
});

Deno.test("error → no output", () => {
  const state = createChatStreamState();
  const result = translateAnthropicEventToChatChunks({
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  }, state);
  assertEquals(result, []);
});

// ── All chunk fields carry correct id/model/created ──

Deno.test("all chunks carry message id, model, and created", () => {
  const chunks = processFlat([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ]);
  for (const chunk of chunks) {
    assertEquals(chunk.id, "msg_test");
    assertEquals(chunk.model, "claude-sonnet-4-20250514");
    assertEquals(chunk.object, "chat.completion.chunk");
    assertEquals(typeof chunk.created, "number");
  }
});

// ── Full streaming scenarios ──

Deno.test("full text stream scenario", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  ]);
  assertEquals(d[0].role, "assistant");
  assertEquals(d[1].content, "Hello");
  assertEquals(d[2].content, " world");
  assertEquals(d.length, 4); // role + 2 text + finish
});

Deno.test("full thinking + text stream scenario", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ]);
  assertEquals(d[0].role, "assistant");
  assertEquals(d[1].reasoning_text, "Let me think");
  assertEquals(d[2].reasoning_opaque, "sig");
  assertEquals(d[3].content, "Answer");
});

Deno.test("full tool_use stream scenario", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Calling tool" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "search", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"test"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
  ]);
  assertEquals(d[0].role, "assistant");
  assertEquals(d[1].content, "Calling tool");
  // tool init
  assertEquals(d[2].tool_calls![0].index, 0);
  assertEquals(d[2].tool_calls![0].id, "tu_1");
  assertEquals(d[2].tool_calls![0].function!.name, "search");
  // tool arguments
  assertEquals(d[3].tool_calls![0].function!.arguments, '{"q":');
  assertEquals(d[4].tool_calls![0].function!.arguments, '"test"}');
});

Deno.test("full redacted_thinking + text stream scenario", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque_blob" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Response" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ]);
  assertEquals(d[0].role, "assistant");
  assertEquals(d[1].reasoning_opaque, "opaque_blob");
  assertEquals(d[2].content, "Response");
});

Deno.test("thinking + tool_use stream (interleaved thinking)", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I need a tool" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_1" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "calc", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
  ]);
  assertEquals(d[0].role, "assistant");
  assertEquals(d[1].reasoning_text, "I need a tool");
  assertEquals(d[2].reasoning_opaque, "sig_1");
  assertEquals(d[3].tool_calls![0].id, "tu_1");
  assertEquals(d[4].tool_calls![0].function!.arguments, '{"x":1}');
});

Deno.test("multiple tool_use blocks in stream", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "f1", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{}' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_2", name: "f2", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
  ]);
  // d[0]=role, d[1]=tool1 init, d[2]=tool1 args, d[3]=tool2 init, d[4]=tool2 args, d[5]=finish
  assertEquals(d[1].tool_calls![0].index, 0);
  assertEquals(d[1].tool_calls![0].id, "tu_1");
  assertEquals(d[3].tool_calls![0].index, 1);
  assertEquals(d[3].tool_calls![0].id, "tu_2");
});

// ── Edge: DONE signal propagation ──

Deno.test("events after message_stop are not processed", () => {
  const results = process([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);
  // Last result should be DONE
  assertEquals(results[results.length - 1], "DONE");
});

// ── Edge: empty deltas ──

Deno.test("empty text_delta produces chunk with empty content", () => {
  const d = deltas([
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } },
  ]);
  assertEquals(d[1].content, "");
});
