import { assertEquals, assertFalse } from "@std/assert";
import {
  translateMessagesToResponses,
  translateMessagesToResponsesResult,
} from "./messages-to-responses.ts";
import { getMessagesRequestedReasoningEffort } from "../reasoning.ts";
import type {
  ResponseInputReasoning,
  ResponseOutputReasoning,
} from "../responses-types.ts";

Deno.test("translateMessagesToResponses uses rs-prefixed ids for reasoning input items", () => {
  const result = translateMessagesToResponses({
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

Deno.test("translateMessagesToResponses drops filtered-native tool_choice and preserves assistant native web-search history as output_text", () => {
  const result = translateMessagesToResponses({
    model: "gpt-test",
    max_tokens: 256,
    tool_choice: { type: "any" },
    tools: [{ type: "web_search_20260209", name: "NativeSearch" }],
    messages: [{
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: "st_1",
          name: "web_search",
          input: { query: "React docs" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "st_1",
          content: [{
            type: "web_search_result",
            url: "https://react.dev",
            title: "React",
            encrypted_content: "cgws1.payload",
          }],
        },
      ],
    }],
  });

  assertEquals(result.tools, null);
  assertEquals(result.tool_choice, "auto");
  assertEquals(result.input, [{
    type: "message",
    role: "assistant",
    content: [{
      type: "output_text",
      text:
        '[{"type":"server_tool_use","id":"st_1","name":"web_search","input":{"query":"React docs"}},{"type":"web_search_tool_result","tool_use_id":"st_1","content":[{"type":"web_search_result","url":"https://react.dev","title":"React","encrypted_content":"cgws1.payload"}]}]',
    }],
  }]);
});

Deno.test("translateMessagesToResponses maps output_config.effort directly to reasoning.effort", () => {
  const result = translateMessagesToResponses({
    model: "gpt-test",
    max_tokens: 256,
    output_config: { effort: "xhigh" },
    messages: [{ role: "user", content: "hi" }],
  });

  assertEquals(result.reasoning, { effort: "xhigh", summary: "detailed" });
});

Deno.test("translateMessagesToResponses preserves output_config.effort max at the translation boundary", () => {
  const result = translateMessagesToResponses({
    model: "gpt-test",
    max_tokens: 256,
    output_config: { effort: "max" },
    messages: [{ role: "user", content: "hi" }],
  });

  assertEquals(result.reasoning, { effort: "max", summary: "detailed" });
});

Deno.test("translateMessagesToResponses preserves max_tokens at the translation boundary", () => {
  const result = translateMessagesToResponses({
    model: "gpt-test",
    max_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
  });

  assertEquals(result.max_output_tokens, 256);
});

Deno.test("translateMessagesToResponses maps thinking.disabled to reasoning.effort none", () => {
  const result = translateMessagesToResponses({
    model: "gpt-test",
    max_tokens: 256,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: "hi" }],
  });

  assertEquals(result.reasoning, { effort: "none", summary: "detailed" });
});

Deno.test("translateMessagesToResponses ignores non-disabled thinking without output_config.effort", () => {
  const result = translateMessagesToResponses({
    model: "gpt-test",
    max_tokens: 256,
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [{ role: "user", content: "hi" }],
  });

  assertFalse("reasoning" in result);
});

Deno.test("getMessagesRequestedReasoningEffort prefers output_config.effort over thinking.disabled", () => {
  assertEquals(
    getMessagesRequestedReasoningEffort({
      model: "claude-test",
      max_tokens: 256,
      output_config: { effort: "high" },
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "hi" }],
    }),
    "high",
  );
});

Deno.test("getMessagesRequestedReasoningEffort maps thinking.disabled to none", () => {
  assertEquals(
    getMessagesRequestedReasoningEffort({
      model: "claude-test",
      max_tokens: 256,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "hi" }],
    }),
    "none",
  );
});

Deno.test("getMessagesRequestedReasoningEffort ignores enabled thinking without output_config.effort", () => {
  assertEquals(
    getMessagesRequestedReasoningEffort({
      model: "claude-test",
      max_tokens: 256,
      thinking: { type: "enabled", budget_tokens: 8192 },
      messages: [{ role: "user", content: "hi" }],
    }),
    null,
  );
});

Deno.test("getMessagesRequestedReasoningEffort ignores bare enabled thinking without budget_tokens", () => {
  assertEquals(
    getMessagesRequestedReasoningEffort({
      model: "claude-test",
      max_tokens: 256,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    }),
    null,
  );
});

Deno.test("translateMessagesToResponsesResult uses rs-prefixed ids for reasoning output items", () => {
  const result = translateMessagesToResponsesResult({
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

Deno.test("translateMessagesToResponsesResult includes cache_creation_input_tokens in input_tokens", () => {
  const result = translateMessagesToResponsesResult({
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

Deno.test("translateMessagesToResponsesResult handles cache_creation without cache_read", () => {
  const result = translateMessagesToResponsesResult({
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
