import { assertEquals, assertFalse } from "@std/assert";
import { translateChatToResponses } from "./chat-to-responses.ts";
import {
  translateAnthropicToResponses,
  translateAnthropicToResponsesResult,
  translateResponsesToAnthropicPayload,
} from "./responses.ts";
import { getAnthropicRequestedReasoningEffort } from "../reasoning.ts";
import type {
  ResponseInputReasoning,
  ResponseOutputReasoning,
} from "../responses-types.ts";

Deno.test("translateAnthropicToResponses uses rs-prefixed ids for reasoning input items", () => {
  const result = translateAnthropicToResponses({
    model: "gpt-test",
    max_tokens: 256,
    messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "trace", signature: "sig" }],
    }],
  });

  if (!Array.isArray(result.input)) throw new Error("expected input array");
  const reasoning = result.input[0] as ResponseInputReasoning;
  assertEquals(reasoning.type, "reasoning");
  assertEquals(reasoning.id, "rs_0");
});

Deno.test("translateChatToResponses uses rs-prefixed ids for reasoning input items", () => {
  const result = translateChatToResponses({
    model: "gpt-test",
    messages: [{
      role: "assistant",
      content: "answer",
      reasoning_text: "trace",
      reasoning_opaque: "enc",
    }],
  });

  if (!Array.isArray(result.input)) throw new Error("expected input array");
  const reasoning = result.input[0] as ResponseInputReasoning;
  assertEquals(reasoning.type, "reasoning");
  assertEquals(reasoning.id, "rs_0");
});

Deno.test("translateAnthropicToResponses maps output_config.effort directly to reasoning.effort", () => {
  const result = translateAnthropicToResponses({
    model: "gpt-test",
    max_tokens: 256,
    output_config: { effort: "xhigh" },
    messages: [{ role: "user", content: "hi" }],
  });

  assertEquals(result.reasoning, { effort: "xhigh", summary: "detailed" });
});

Deno.test("translateAnthropicToResponses preserves output_config.effort max at the translation boundary", () => {
  const result = translateAnthropicToResponses({
    model: "gpt-test",
    max_tokens: 256,
    output_config: { effort: "max" },
    messages: [{ role: "user", content: "hi" }],
  });

  assertEquals(result.reasoning, { effort: "max", summary: "detailed" });
});

Deno.test("translateAnthropicToResponses maps thinking.disabled to reasoning.effort none", () => {
  const result = translateAnthropicToResponses({
    model: "gpt-test",
    max_tokens: 256,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: "hi" }],
  });

  assertEquals(result.reasoning, { effort: "none", summary: "detailed" });
});

Deno.test("translateAnthropicToResponses ignores non-disabled thinking without output_config.effort", () => {
  const result = translateAnthropicToResponses({
    model: "gpt-test",
    max_tokens: 256,
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [{ role: "user", content: "hi" }],
  });

  assertFalse("reasoning" in result);
});

Deno.test("translateResponsesToAnthropicPayload maps reasoning.effort none to thinking.disabled", () => {
  const result = translateResponsesToAnthropicPayload({
    model: "claude-test",
    input: [{ type: "message", role: "user", content: "hi" }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: "auto",
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: "none", summary: "detailed" },
  });

  assertEquals(result.thinking, { type: "disabled" });
  assertFalse("output_config" in result);
});

Deno.test("translateResponsesToAnthropicPayload maps reasoning.effort directly to output_config.effort", () => {
  const result = translateResponsesToAnthropicPayload({
    model: "claude-test",
    input: [{ type: "message", role: "user", content: "hi" }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: "auto",
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: "minimal", summary: "detailed" },
  });

  assertEquals(result.output_config, { effort: "minimal" });
  assertFalse("thinking" in result);
});

Deno.test("getAnthropicRequestedReasoningEffort prefers output_config.effort over thinking.disabled", () => {
  assertEquals(
    getAnthropicRequestedReasoningEffort({
      model: "claude-test",
      max_tokens: 256,
      output_config: { effort: "high" },
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "hi" }],
    }),
    "high",
  );
});

Deno.test("getAnthropicRequestedReasoningEffort maps thinking.disabled to none", () => {
  assertEquals(
    getAnthropicRequestedReasoningEffort({
      model: "claude-test",
      max_tokens: 256,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "hi" }],
    }),
    "none",
  );
});

Deno.test("getAnthropicRequestedReasoningEffort ignores enabled thinking without output_config.effort", () => {
  assertEquals(
    getAnthropicRequestedReasoningEffort({
      model: "claude-test",
      max_tokens: 256,
      thinking: { type: "enabled", budget_tokens: 8192 },
      messages: [{ role: "user", content: "hi" }],
    }),
    null,
  );
});

Deno.test("getAnthropicRequestedReasoningEffort ignores bare enabled thinking without budget_tokens", () => {
  assertEquals(
    getAnthropicRequestedReasoningEffort({
      model: "claude-test",
      max_tokens: 256,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    }),
    null,
  );
});

Deno.test("translateAnthropicToResponsesResult uses rs-prefixed ids for reasoning output items", () => {
  const result = translateAnthropicToResponsesResult({
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "thinking", thinking: "trace", signature: "sig" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  const reasoning = result.output[0] as ResponseOutputReasoning;
  assertEquals(reasoning.type, "reasoning");
  assertEquals(reasoning.id, "rs_0");
});

Deno.test("translateAnthropicToResponsesResult includes cache_creation_input_tokens in input_tokens", () => {
  const result = translateAnthropicToResponsesResult({
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    },
  });

  assertEquals(result.usage!.input_tokens, 150); // 100 + 20 + 30
  assertEquals(result.usage!.output_tokens, 50);
  assertEquals(result.usage!.total_tokens, 200);
  assertEquals(result.usage!.input_tokens_details!.cached_tokens, 20);
});

Deno.test("translateAnthropicToResponsesResult handles cache_creation without cache_read", () => {
  const result = translateAnthropicToResponsesResult({
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 30,
    },
  });

  assertEquals(result.usage!.input_tokens, 130); // 100 + 0 + 30
  assertEquals(result.usage!.total_tokens, 180);
  assertEquals(result.usage!.input_tokens_details, undefined);
});
