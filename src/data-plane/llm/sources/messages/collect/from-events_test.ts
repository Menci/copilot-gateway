import { assertEquals } from "@std/assert";
import type { AnthropicResponse } from "../../../../../lib/messages-types.ts";
import { collectSSE } from "../../../shared/stream/collect-sse.ts";
import { jsonFrame } from "../../../shared/stream/types.ts";
import {
  collectAnthropicEventsToResponse,
  expandAnthropicFrames,
} from "./from-events.ts";

Deno.test("collectAnthropicEventsToResponse round-trips native web search JSON frames", async () => {
  const response: AnthropicResponse = {
    id: "msg_roundtrip",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_reason: "pause_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      server_tool_use: { web_search_requests: 1 },
    },
    content: [
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "latest React documentation" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{
          type: "web_search_result",
          url: "https://react.dev",
          title: "React",
          encrypted_content: "cgws1.eyJjb250ZW50IjpbXX0",
        }],
      },
      {
        type: "text",
        text: "Use the docs.",
        citations: [{
          type: "web_search_result_location",
          url: "https://react.dev",
          title: "React",
          encrypted_index:
            "cgws1.eyJzZWFyY2hfcmVzdWx0X2luZGV4IjowLCJzdGFydF9ibG9ja19pbmRleCI6MCwiZW5kX2Jsb2NrX2luZGV4IjowfQ",
          cited_text: "Official React docs",
        }],
      },
    ],
  };

  const collected = await collectAnthropicEventsToResponse((async function* () {
    yield jsonFrame(response);
  })());

  assertEquals(collected, response);
});

Deno.test("collectAnthropicEventsToResponse preserves citations when text is empty", async () => {
  const response: AnthropicResponse = {
    id: "msg_empty_text_citations",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
    content: [{
      type: "text",
      text: "",
      citations: [{
        type: "web_search_result_location",
        url: "https://react.dev",
        title: "React",
        encrypted_index: "cgws1.empty",
        cited_text: "Official React docs",
      }],
    }],
  };

  const collected = await collectAnthropicEventsToResponse((async function* () {
    yield jsonFrame(response);
  })());

  assertEquals(collected, response);
});

Deno.test("expandAnthropicFrames emits native-like citations_delta frames", async () => {
  const response: AnthropicResponse = {
    id: "msg_emit_citations",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
    content: [{
      type: "text",
      text: "Use the docs.",
      citations: [
        {
          type: "search_result_location",
          url: "https://react.dev/learn",
          title: "Quick Start - React",
          search_result_index: 1,
          start_block_index: 0,
          end_block_index: 1,
          cited_text: "Quick Start citation",
        },
        {
          type: "web_search_result_location",
          url: "https://react.dev",
          title: "React",
          encrypted_index: "cgws1.synthetic",
          cited_text: "Native-looking citation",
        },
      ],
    }],
  };

  const frames = await collectSSE(expandAnthropicFrames((async function* () {
    yield jsonFrame(response);
  })()));

  assertEquals(frames[1]?.event, "content_block_start");
  assertEquals(JSON.parse(frames[1]!.data), {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: [] },
  });
  assertEquals(JSON.parse(frames[2]!.data), {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "citations_delta",
      citation: {
        type: "search_result_location",
        source: "https://react.dev/learn",
        title: "Quick Start - React",
        search_result_index: 1,
        start_block_index: 0,
        end_block_index: 1,
        cited_text: "Quick Start citation",
      },
    },
  });
  assertEquals(JSON.parse(frames[3]!.data), {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "citations_delta",
      citation: {
        type: "web_search_result_location",
        url: "https://react.dev",
        title: "React",
        encrypted_index: "cgws1.synthetic",
        cited_text: "Native-looking citation",
      },
    },
  });
  assertEquals(JSON.parse(frames[4]!.data), {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "text_delta",
      text: "Use the docs.",
    },
  });
});
