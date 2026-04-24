import { assertEquals, assertRejects } from "@std/assert";
import {
  reassembleAnthropicSSE,
  reassembleChatCompletionsSSE,
  reassembleMessagesSSE,
  reassembleResponsesSSE,
} from "./sse-reassemble.ts";
import type {
  AnthropicResponse,
  AnthropicSearchResultBlock,
  AnthropicSearchResultLocationCitation,
  AnthropicServerToolUseBlock,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultContentBlock,
  AnthropicWebSearchResultBlock,
  AnthropicWebSearchToolResultBlock,
  MessagesResponse,
} from "./messages-types.ts";
import type { ChatCompletionResponse } from "./chat-completions-types.ts";
import type { ResponsesResult } from "./responses-types.ts";

function makeSSEBody(
  chunks: Array<{ event?: string; data: unknown }>,
): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => {
    const lines: string[] = [];
    if (c.event) lines.push(`event: ${c.event}`);
    const data = typeof c.data === "string" ? c.data : JSON.stringify(c.data);
    lines.push(`data: ${data}`);
    return lines.join("\n");
  }).join("\n\n") + "\n\n";

  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type _toolResultContentExcludesWebSearchResult = Expect<
  Equal<
    Extract<AnthropicToolResultContentBlock, AnthropicWebSearchResultBlock>,
    never
  >
>;
type _serverToolUseNameIsString = Expect<
  Equal<AnthropicServerToolUseBlock["name"], string>
>;
type _serverToolUseInputIsQueryObject = Expect<
  Equal<AnthropicServerToolUseBlock["input"], { query: string }>
>;

// ── reassembleMessagesSSE ──

Deno.test("reassembleMessagesSSE reassembles text response", async () => {
  const body = makeSSEBody([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello " },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world" },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const result: MessagesResponse = await reassembleMessagesSSE(body);

  assertEquals(result.id, "msg_1");
  assertEquals(result.model, "claude-test");
  assertEquals(result.stop_reason, "end_turn");
  assertEquals(result.content.length, 1);
  assertEquals(result.content[0].type, "text");
  assertEquals(
    (result.content[0] as { type: "text"; text: string }).text,
    "Hello world",
  );
  assertEquals(result.usage.input_tokens, 10);
  assertEquals(result.usage.output_tokens, 5);
});

// ── reassembleAnthropicSSE ──

Deno.test("AnthropicTool supports both client and native web search shapes", () => {
  const clientTool: AnthropicTool = {
    name: "get_weather",
    description: "Fetches weather",
    input_schema: { type: "object" },
    strict: true,
  };

  const nativeWebSearchTool: AnthropicTool = {
    type: "web_search_20250305",
    max_uses: 3,
    allowed_domains: ["example.com"],
    user_location: {
      type: "approximate",
      city: "San Francisco",
      region: "CA",
      country: "US",
      timezone: "America/Los_Angeles",
    },
  };

  assertEquals("name" in clientTool, true);
  assertEquals(nativeWebSearchTool.type, "web_search_20250305");
  if ("user_location" in nativeWebSearchTool) {
    assertEquals(nativeWebSearchTool.user_location?.type, "approximate");
  }
});

Deno.test("Anthropic native web search shared shapes match Task 1 contracts", () => {
  const searchCitation: AnthropicSearchResultLocationCitation = {
    type: "search_result_location",
    url: "https://docs.example.com/api-guide",
    title: "API Guide",
    search_result_index: 0,
    start_block_index: 1,
    end_block_index: 2,
    cited_text: "Error handling guidance",
  };

  const searchResult: AnthropicSearchResultBlock = {
    type: "search_result",
    source: "https://docs.example.com/api-guide",
    title: "API Guide",
    content: [{ type: "text", text: "Error handling guidance" }],
    citations: { enabled: true },
  };

  const serverToolUse: AnthropicServerToolUseBlock = {
    type: "server_tool_use",
    id: "srvtoolu_1",
    name: "web_search",
    input: { query: "latest API guide" },
  };

  const webSearchToolResult: AnthropicWebSearchToolResultBlock = {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: {
      type: "web_search_tool_result_error",
      error_code: "max_uses_exceeded",
    },
  };

  assertEquals(searchCitation.search_result_index, 0);
  assertEquals(searchResult.citations?.enabled, true);
  assertEquals(serverToolUse.name, "web_search");
  assertEquals(Array.isArray(webSearchToolResult.content), false);
  if (!Array.isArray(webSearchToolResult.content)) {
    assertEquals(
      webSearchToolResult.content.type,
      "web_search_tool_result_error",
    );
  }
});

Deno.test("reassembleAnthropicSSE reassembles text response", async () => {
  const body = makeSSEBody([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello " },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world" },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const result: MessagesResponse = await reassembleMessagesSSE(body);

  assertEquals(result.id, "msg_1");
  assertEquals(result.model, "claude-test");
  assertEquals(result.stop_reason, "end_turn");
  assertEquals(result.content.length, 1);
  assertEquals(result.content[0].type, "text");
  assertEquals(
    (result.content[0] as { type: "text"; text: string }).text,
    "Hello world",
  );
  assertEquals(result.usage.input_tokens, 10);
  assertEquals(result.usage.output_tokens, 5);
});

Deno.test("reassembleMessagesSSE reassembles tool_use response", async () => {
  const body = makeSSEBody([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "calc" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"x":' },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "42}" },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 10 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const result = await reassembleMessagesSSE(body);

  assertEquals(result.stop_reason, "tool_use");
  assertEquals(result.content.length, 1);
  assertEquals(result.content[0].type, "tool_use");
  const tu = result.content[0] as {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
  assertEquals(tu.id, "tu_1");
  assertEquals(tu.name, "calc");
  assertEquals(tu.input, { x: 42 });
});

Deno.test("reassembleMessagesSSE reassembles thinking blocks", async () => {
  const body = makeSSEBody([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_3",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "let me think" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_123" },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "answer" },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 1 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 20 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const result = await reassembleMessagesSSE(body);

  assertEquals(result.content.length, 2);
  assertEquals(result.content[0].type, "thinking");
  const thinking = result.content[0] as {
    type: "thinking";
    thinking: string;
    signature?: string;
  };
  assertEquals(thinking.thinking, "let me think");
  assertEquals(thinking.signature, "sig_123");
  assertEquals(result.content[1].type, "text");
});

Deno.test("reassembleMessagesSSE throws on error event", async () => {
  const body = makeSSEBody([
    {
      event: "error",
      data: {
        type: "error",
        error: { type: "overloaded_error", message: "overloaded" },
      },
    },
  ]);

  await assertRejects(
    () => reassembleMessagesSSE(body),
    Error,
    "overloaded",
  );
});

Deno.test("reassembleAnthropicSSE reassembles native web search blocks and usage", async () => {
  const body = makeSSEBody([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_ws",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            server_tool_use: { web_search_requests: 0 },
          },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "web_search",
          input: { query: "Claude Shannon birth date" },
        },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [{
            type: "web_search_result",
            url: "https://example.com/shannon",
            title: "Claude Shannon",
            encrypted_content: "cgws1.eyJjb250ZW50IjpbXX0",
            page_age: "2025-04-30",
          }],
        },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 1 },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 2,
        delta: {
          type: "text_delta",
          text: "Claude Shannon was born in 1916.",
          citations: [{
            type: "web_search_result_location",
            url: "https://example.com/shannon",
            title: "Claude Shannon",
            encrypted_index:
              "cgws1.eyJzZWFyY2hfcmVzdWx0X2luZGV4IjowLCJzdGFydF9ibG9ja19pbmRleCI6MCwiZW5kX2Jsb2NrX2luZGV4IjowfQ",
            cited_text: "Claude Shannon (1916-2001)",
          }],
        },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 2 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "pause_turn", stop_sequence: null },
        usage: {
          output_tokens: 9,
          server_tool_use: { web_search_requests: 1 },
        },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const result = await reassembleAnthropicSSE(body);

  assertEquals(result.stop_reason, "pause_turn");
  assertEquals(result.usage.server_tool_use?.web_search_requests, 1);
  assertEquals(result.content[0].type, "server_tool_use");
  assertEquals(result.content[1].type, "web_search_tool_result");
  assertEquals(result.content[2].type, "text");
  assertEquals(
    (result.content[2] as AnthropicTextBlock).citations?.[0]?.type,
    "web_search_result_location",
  );
});

Deno.test("reassembleAnthropicSSE accumulates citations across multiple text deltas", async () => {
  const body = makeSSEBody([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_citations",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "First sentence. ",
          citations: [{
            type: "web_search_result_location",
            url: "https://example.com/one",
            title: "One",
            encrypted_index: "cgws1.first",
            cited_text: "First source",
          }],
        },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "Second sentence.",
          citations: [{
            type: "web_search_result_location",
            url: "https://example.com/two",
            title: "Two",
            encrypted_index: "cgws1.second",
            cited_text: "Second source",
          }],
        },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const result = await reassembleAnthropicSSE(body);
  const block = result.content[0] as AnthropicTextBlock;

  assertEquals(block.text, "First sentence. Second sentence.");
  assertEquals(block.citations?.length, 2);
  assertEquals(block.citations?.[0]?.type, "web_search_result_location");
  assertEquals(block.citations?.[1]?.type, "web_search_result_location");
});

Deno.test("reassembleAnthropicSSE handles citations_delta and normalizes source fields", async () => {
  const body = makeSSEBody([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_citations_delta",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: [] },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "citations_delta",
          citation: {
            type: "search_result_location",
            source: "https://example.com/source-only",
            title: "Source Only",
            search_result_index: 0,
            start_block_index: 0,
            end_block_index: 1,
            cited_text: "Source-only citation",
          },
        },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Quoted text." },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const result = await reassembleAnthropicSSE(body);
  const block = result.content[0] as AnthropicTextBlock;

  assertEquals(block.text, "Quoted text.");
  assertEquals(block.citations?.length, 1);
  assertEquals(block.citations?.[0], {
    type: "search_result_location",
    url: "https://example.com/source-only",
    title: "Source Only",
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 1,
    cited_text: "Source-only citation",
  });
});

// ── reassembleChatCompletionsSSE ──

Deno.test("reassembleChatCompletionsSSE reassembles text response", async () => {
  const body = makeSSEBody([
    {
      data: {
        id: "cmpl_1",
        object: "chat.completion.chunk",
        created: 1000,
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "Hello" },
          finish_reason: null,
        }],
      },
    },
    {
      data: {
        id: "cmpl_1",
        object: "chat.completion.chunk",
        created: 1000,
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: { content: " world" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    },
    { data: "[DONE]" },
  ]);

  const result: ChatCompletionResponse = await reassembleChatCompletionsSSE(
    body,
  );

  assertEquals(result.id, "cmpl_1");
  assertEquals(result.model, "gpt-test");
  assertEquals(result.created, 1000);
  assertEquals(result.object, "chat.completion");
  assertEquals(result.choices.length, 1);
  assertEquals(result.choices[0].index, 0);
  assertEquals(result.choices[0].message.content, "Hello world");
  assertEquals(result.choices[0].finish_reason, "stop");
  assertEquals(result.usage?.prompt_tokens, 10);
});

Deno.test("reassembleChatCompletionsSSE reassembles tool calls", async () => {
  const body = makeSSEBody([
    {
      data: {
        id: "cmpl_2",
        object: "chat.completion.chunk",
        created: 2000,
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: "",
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"city"' },
            }],
          },
          finish_reason: null,
        }],
      },
    },
    {
      data: {
        id: "cmpl_2",
        object: "chat.completion.chunk",
        created: 2000,
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: ':"Tokyo"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    },
    { data: "[DONE]" },
  ]);

  const result = await reassembleChatCompletionsSSE(body);

  assertEquals(result.choices[0].finish_reason, "tool_calls");
  assertEquals(result.choices[0].message.tool_calls?.length, 1);
  assertEquals(result.choices[0].message.tool_calls![0].id, "call_1");
  assertEquals(
    result.choices[0].message.tool_calls![0].function.name,
    "lookup",
  );
  assertEquals(
    result.choices[0].message.tool_calls![0].function.arguments,
    '{"city":"Tokyo"}',
  );
});

Deno.test("reassembleChatCompletionsSSE reassembles reasoning fields", async () => {
  const body = makeSSEBody([
    {
      data: {
        id: "cmpl_3",
        object: "chat.completion.chunk",
        created: 3000,
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            reasoning_text: "think",
            reasoning_opaque: "enc",
          },
          finish_reason: null,
        }],
      },
    },
    {
      data: {
        id: "cmpl_3",
        object: "chat.completion.chunk",
        created: 3000,
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: { content: "reply" },
          finish_reason: "stop",
        }],
      },
    },
    { data: "[DONE]" },
  ]);

  const result = await reassembleChatCompletionsSSE(body);

  assertEquals(result.choices[0].message.reasoning_text, "think");
  assertEquals(result.choices[0].message.reasoning_opaque, "enc");
  assertEquals(result.choices[0].message.content, "reply");
});

// ── reassembleResponsesSSE ──

Deno.test("reassembleResponsesSSE extracts response from completed event", async () => {
  const expected: ResponsesResult = {
    id: "resp_1",
    object: "response",
    model: "gpt-test",
    status: "completed",
    output_text: "Hello",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello" }],
    }],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };

  const body = makeSSEBody([
    {
      event: "response.created",
      data: {
        type: "response.created",
        response: { ...expected, status: "in_progress" },
      },
    },
    {
      event: "response.in_progress",
      data: {
        type: "response.in_progress",
        response: { ...expected, status: "in_progress" },
      },
    },
    {
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", delta: "Hello" },
    },
    {
      event: "response.completed",
      data: { type: "response.completed", response: expected },
    },
  ]);

  const result = await reassembleResponsesSSE(body);

  assertEquals(result.id, "resp_1");
  assertEquals(result.status, "completed");
  assertEquals(result.output_text, "Hello");
});

Deno.test("reassembleResponsesSSE handles incomplete event", async () => {
  const incomplete: ResponsesResult = {
    id: "resp_2",
    object: "response",
    model: "gpt-test",
    status: "incomplete",
    output_text: "",
    output: [],
    incomplete_details: { reason: "max_tokens" },
  };

  const body = makeSSEBody([
    {
      event: "response.incomplete",
      data: { type: "response.incomplete", response: incomplete },
    },
  ]);

  const result = await reassembleResponsesSSE(body);
  assertEquals(result.status, "incomplete");
});

Deno.test("reassembleResponsesSSE throws on error event", async () => {
  const body = makeSSEBody([
    { event: "error", data: { type: "error", message: "bad request" } },
  ]);

  await assertRejects(
    () => reassembleResponsesSSE(body),
    Error,
    "bad request",
  );
});

Deno.test("reassembleResponsesSSE throws when stream ends without terminal event", async () => {
  const body = makeSSEBody([
    {
      event: "response.created",
      data: { type: "response.created", response: {} },
    },
  ]);

  await assertRejects(
    () => reassembleResponsesSSE(body),
    Error,
    "terminal",
  );
});
