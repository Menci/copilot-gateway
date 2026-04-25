import { assertEquals, assertExists, assertFalse } from "@std/assert";
import type { ResponsesResult } from "../../../../lib/responses-types.ts";
import type { SearchConfig } from "../../../tools/web-search/types.ts";
import {
  copilotModels,
  jsonResponse,
  parseSSEText,
  requestApp,
  setupAppTest,
  sseResponse,
  withMockedFetch,
} from "../../../../test-helpers.ts";

const ENABLED_SEARCH_CONFIG: SearchConfig = {
  provider: "tavily",
  tavily: { apiKey: "tvly-test" },
  microsoftGrounding: { apiKey: "" },
};

const encodeShimPayloadForTest = (payload: unknown): string => {
  const json = JSON.stringify(payload);
  let binary = "";
  for (const byte of new TextEncoder().encode(json)) {
    binary += String.fromCharCode(byte);
  }

  return `cgws1.${
    btoa(binary).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/g, "")
  }`;
};

const encodeWebSearchResultPayloadForTest = (
  payload: { content: Array<{ type: "text"; text: string }> },
) => encodeShimPayloadForTest({ content: payload.content });

const encodeWebSearchCitationPayloadForTest = (
  payload: {
    search_result_index: number;
    start_block_index: number;
    end_block_index: number;
  },
) =>
  encodeShimPayloadForTest({
    search_result_index: payload.search_result_index,
    start_block_index: payload.start_block_index,
    end_block_index: payload.end_block_index,
  });

const makeWebSearchTool = () => ({
  type: "web_search_20260209" as const,
  name: "web_search",
  max_uses: 2,
});

const makeAssistantSSE = (
  messageId: string,
  contentBlocks: Array<{ event: string; data: Record<string, unknown> }>,
  stopReason: "end_turn" | "pause_turn" | "tool_use" = "end_turn",
) =>
  sseResponse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-native",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    ...contentBlocks,
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

const textBlock = (text: string) => [
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
      delta: { type: "text_delta", text },
    },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 0 },
  },
];

const toolUseBlock = (
  index: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
) => [
  {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(input),
      },
    },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index },
  },
];

const makeNativeSearchReplayMessages = () => [
  { role: "user", content: "latest React docs" },
  {
    role: "assistant",
    content: [
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "latest React docs" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{
          type: "web_search_result",
          url: "https://react.dev",
          title: "React",
          encrypted_content: encodeWebSearchResultPayloadForTest({
            content: [{ type: "text", text: "Official React documentation" }],
          }),
        }],
      },
      {
        type: "text",
        text: "Use the React docs.",
        citations: [{
          type: "web_search_result_location",
          url: "https://react.dev",
          title: "React",
          encrypted_index: encodeWebSearchCitationPayloadForTest({
            search_result_index: 0,
            start_block_index: 0,
            end_block_index: 0,
          }),
          cited_text: "Official React documentation",
        }],
      },
    ],
  },
];

const makeForeignSearchReplayMessages = () => [
  { role: "user", content: "latest React docs" },
  {
    role: "assistant",
    content: [
      {
        type: "server_tool_use",
        id: "srvtoolu_foreign",
        name: "web_search",
        input: { query: "latest React docs" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_foreign",
        content: [{
          type: "web_search_result",
          url: "https://react.dev",
          title: "React",
          encrypted_content: "foreign.payload",
        }],
      },
    ],
  },
];

const makeNativeSearchErrorReplayMessages = () => [
  { role: "user", content: "latest React docs" },
  {
    role: "assistant",
    content: [
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "latest React docs" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: {
          type: "web_search_tool_result_error",
          error_code: "too_many_requests",
        },
      },
    ],
  },
];

const makeNativeWebSearchUpstreamHandler = (
  options: {
    upstreamResponse: Response;
    searchResponse?: Response;
    capture?: {
      upstreamBody?: Record<string, unknown>;
      upstreamBeta?: string | null;
      searchBody?: Record<string, unknown>;
    };
  },
) =>
async (request: Request): Promise<Response> => {
  const url = new URL(request.url);

  if (url.hostname === "update.code.visualstudio.com") {
    return jsonResponse(["1.110.1"]);
  }

  if (url.pathname === "/copilot_internal/v2/token") {
    return jsonResponse({
      token: "copilot-access-token",
      expires_at: 4102444800,
      refresh_in: 3600,
    });
  }

  if (url.pathname === "/models") {
    return jsonResponse(copilotModels([
      { id: "claude-native", supported_endpoints: ["/v1/messages"] },
    ]));
  }

  if (url.pathname === "/v1/messages") {
    if (options.capture) {
      options.capture.upstreamBody = JSON.parse(await request.text());
      options.capture.upstreamBeta = request.headers.get("anthropic-beta");
    }

    return options.upstreamResponse;
  }

  if (url.hostname === "api.tavily.com" && url.pathname === "/search") {
    if (options.capture) {
      options.capture.searchBody = JSON.parse(await request.text());
    }

    return options.searchResponse ?? jsonResponse({
      results: [{
        title: "React",
        url: "https://react.dev",
        published_date: "2026-04-01",
        content: "Official React docs",
      }],
    });
  }

  throw new Error(`Unhandled fetch ${request.url}`);
};

const setupNativeWebSearchRouteTest = () =>
  setupAppTest({
    searchConfig: ENABLED_SEARCH_CONFIG,
  });

Deno.test("/v1/messages malformed JSON returns structured internal debug error", async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey.key,
    },
    body: "{",
  });

  assertEquals(response.status, 502);

  const body = await response.json();
  assertEquals(body.type, "error");
  assertEquals(body.error.type, "internal_error");
  assertEquals(body.error.name, "SyntaxError");
  assertEquals(body.error.source_api, "messages");
  assertExists(body.error.stack);
});

Deno.test("/v1/messages rewrites upstream context-window errors to Messages compact form", async () => {
  const { apiKey } = await setupAppTest();

  const upstreamError = {
    error: {
      message: "Request body is too large for model context window",
      type: "invalid_request_error",
    },
  };

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages") {
      return jsonResponse(upstreamError, 400);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.",
      },
    });
  });
});

Deno.test("/messages uses the same data-plane handler as /v1/messages", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages") {
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_alias",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-native",
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
            delta: { type: "text_delta", text: "ok" },
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
            usage: { output_tokens: 1 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.id, "msg_alias");
    assertEquals(body.content[0].text, "ok");
  });
});

Deno.test("/v1/messages uses native endpoint and applies native request workarounds", async () => {
  const { apiKey, githubAccount } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamBeta: string | null = null;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages") {
      upstreamBody = JSON.parse(await request.text());
      upstreamBeta = request.headers.get("anthropic-beta");
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_native",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-native",
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
            delta: { type: "text_delta", text: "ok" },
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
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
        "anthropic-beta": "context-management-2025-06-27,unknown-beta",
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: false,
        system:
          "system note\nx-anthropic-billing-header: cc_version=2.1.114; cc_entrypoint=cli; cch=abcde12345;",
        service_tier: "auto",
        thinking: { type: "enabled", budget_tokens: 512 },
        tools: [
          { type: "web_search", name: "web", input_schema: {} },
          {
            name: "calc",
            description: "calculator",
            input_schema: { type: "object" },
          },
        ],
        messages: [
          { role: "user", content: "hello x-anthropic-billing-header world" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "Thinking...",
                signature: "opaque@reasoning",
              },
              { type: "thinking", thinking: "kept", signature: "sig_ok" },
              { type: "text", text: "previous reply" },
            ],
          },
          { role: "user", content: "continue" },
        ],
      }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.id, "msg_native");
    assertEquals(body.content[0].text, "ok");
  });

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertEquals(upstreamBody!.system, "system note");
  assertFalse("service_tier" in upstreamBody!);
  assertEquals(
    (upstreamBody!.tools as Array<Record<string, unknown>>).length,
    1,
  );
  assertEquals(
    (upstreamBody!.tools as Array<Record<string, unknown>>)[0].name,
    "calc",
  );
  assertEquals(
    (upstreamBody!.messages as Array<Record<string, unknown>>)[0].content,
    "hello x-anthropic-billing-header world",
  );
  const assistantMessage =
    (upstreamBody!.messages as Array<Record<string, unknown>>)[1];
  const assistantContent = assistantMessage.content as Array<
    Record<string, unknown>
  >;
  assertEquals(assistantContent.length, 2);
  assertEquals(assistantContent[0].type, "thinking");
  assertEquals(assistantContent[0].thinking, "kept");
  assertEquals(assistantContent[1].type, "text");
  assertEquals(
    upstreamBeta,
    "context-management-2025-06-27,interleaved-thinking-2025-05-14",
  );
  assertEquals(githubAccount.accountType, "individual");
});

Deno.test("/v1/messages keeps caller thinking and tool_choice unchanged on native adaptive models", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamBeta: string | null = null;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        {
          id: "claude-adaptive",
          supported_endpoints: ["/v1/messages"],
          adaptiveThinking: true,
        },
      ]));
    }
    if (url.pathname === "/v1/messages") {
      upstreamBody = JSON.parse(await request.text());
      upstreamBeta = request.headers.get("anthropic-beta");
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_native",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-adaptive",
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
            delta: { type: "text_delta", text: "ok" },
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
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-adaptive",
        max_tokens: 64,
        stream: false,
        tool_choice: { type: "any" },
        tools: [
          {
            name: "calc",
            description: "calculator",
            input_schema: { type: "object" },
          },
        ],
        messages: [
          { role: "user", content: "hello" },
        ],
      }),
    });

    assertEquals(response.status, 200);
  });

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertFalse("thinking" in upstreamBody!);
  assertFalse("output_config" in upstreamBody!);
  assertEquals(
    (upstreamBody!.tool_choice as Record<string, unknown>).type,
    "any",
  );
  assertEquals(upstreamBeta, null);
});

Deno.test("/v1/messages native streaming filters trailing DONE sentinel", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages") {
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_123",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-native",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 11, output_tokens: 0 },
            },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
        { data: "[DONE]" },
      ]);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 200);

    const text = await response.text();
    assertFalse(text.includes("[DONE]"));

    const events = parseSSEText(text);
    assertEquals(events.length, 2);
    assertEquals(events[0].event, "message_start");
    assertEquals(events[1].event, "message_stop");
  });
});

Deno.test("/v1/messages forwards Messages tool strict field on native messages", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages") {
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_native",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-native",
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
            delta: { type: "text_delta", text: "ok" },
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
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: false,
        tools: [{
          name: "calc",
          input_schema: { type: "object" },
          strict: true,
        }],
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 200);
  });

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertEquals(
    (upstreamBody!.tools as Array<Record<string, unknown>>)[0].strict,
    true,
  );
});

Deno.test("/v1/messages keeps strict Messages tools on native messages when both endpoints are available", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        {
          id: "claude-dual-endpoint",
          supported_endpoints: ["/v1/messages", "/chat/completions"],
        },
      ]));
    }
    if (url.pathname === "/v1/messages") {
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_dual",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-dual-endpoint",
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
            delta: { type: "text_delta", text: "ok" },
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
    }
    if (url.pathname === "/chat/completions") {
      throw new Error(
        "chat fallback should not be used for strict Messages tools",
      );
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-dual-endpoint",
        max_tokens: 64,
        stream: false,
        tools: [{
          name: "calc",
          description: "calculator",
          input_schema: { type: "object" },
          strict: true,
        }],
        messages: [{ role: "user", content: "Reply with exactly OK." }],
      }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.id, "msg_dual");
  });

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertEquals(
    (upstreamBody!.tools as Array<Record<string, unknown>>)[0].strict,
    true,
  );
});

Deno.test("/v1/messages falls back to chat completions and translates both directions", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "gpt-chat-only", supported_endpoints: ["/chat/completions"] },
      ]));
    }
    if (url.pathname === "/chat/completions") {
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          data: {
            id: "chatcmpl_test123",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-chat-only",
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                content: "Need a tool",
                reasoning_text: "thinking",
                reasoning_opaque: "opaque",
                tool_calls: [{
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"city":"Tokyo"}' },
                }],
              },
              finish_reason: "tool_calls",
            }],
            usage: {
              prompt_tokens: 40,
              completion_tokens: 8,
              prompt_tokens_details: { cached_tokens: 5 },
            },
          },
        },
        { data: "[DONE]" },
      ]);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "gpt-chat-only",
        max_tokens: 128,
        stream: false,
        system: "be precise",
        tool_choice: { type: "any" },
        tools: [{
          name: "lookup",
          description: "Find facts",
          input_schema: { type: "object" },
          strict: true,
        }],
        messages: [{ role: "user", content: "What is the weather?" }],
      }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.stop_reason, "tool_use");
    assertEquals(body.usage.input_tokens, 35);
    assertEquals(body.usage.cache_read_input_tokens, 5);
    assertEquals(body.content[0].type, "thinking");
    assertEquals(body.content[1].type, "text");
    assertEquals(body.content[2].type, "tool_use");
  });

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  const messages = upstreamBody!.messages as Array<Record<string, unknown>>;
  assertEquals(messages[0].role, "system");
  assertEquals(messages[1].role, "user");
  assertEquals(upstreamBody!.tool_choice, "required");
  assertEquals(
    (upstreamBody!.tools as Array<Record<string, unknown>>)[0].type,
    "function",
  );
  assertEquals(
    ((upstreamBody!.tools as Array<Record<string, unknown>>)[0]
      .function as Record<string, unknown>).strict,
    true,
  );
});

Deno.test("/v1/messages falls back to responses and preserves reasoning round-trip details", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;
  let responsesRequests = 0;

  const responsesResult: ResponsesResult = {
    id: "resp_123",
    object: "response",
    model: "gpt-responses-only",
    status: "completed",
    output_text: "Answer text",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "brief reasoning" }],
        encrypted_content: "enc_abc",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Answer text" }],
      },
    ],
    usage: {
      input_tokens: 30,
      output_tokens: 9,
      total_tokens: 39,
      input_tokens_details: { cached_tokens: 5 },
    },
  };

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "gpt-responses-only", supported_endpoints: ["/responses"] },
      ]));
    }
    if (url.pathname === "/responses") {
      responsesRequests += 1;
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: responsesResult,
          },
        },
      ]);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "gpt-responses-only",
        max_tokens: 256,
        system: "system instructions",
        stream: false,
        tools: [{
          name: "lookup",
          description: "Find facts",
          input_schema: { type: "object" },
          strict: true,
        }],
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.id, "resp_123");
    assertEquals(body.usage.input_tokens, 25);
    assertEquals(body.usage.cache_read_input_tokens, 5);
    assertEquals(body.content[0].type, "thinking");
    assertEquals(body.content[0].signature, "enc_abc");
    assertEquals(body.content[1].text, "Answer text");
  });

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertEquals(responsesRequests, 1);
  assertEquals(upstreamBody!.instructions, "system instructions");
  assertEquals(upstreamBody!.temperature, 1);
  assertEquals(upstreamBody!.max_output_tokens, 12800);
  assertFalse("reasoning" in upstreamBody!);
  assertFalse("include" in upstreamBody!);
  assertEquals(
    (upstreamBody!.tools as Array<Record<string, unknown>>)[0].strict,
    true,
  );
});

Deno.test("/v1/messages preserves output_config.effort max when translating to responses", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        {
          id: "gpt-responses-max-effort",
          supported_endpoints: ["/responses"],
        },
      ]));
    }
    if (url.pathname === "/responses") {
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              id: "resp_max_effort",
              object: "response",
              model: "gpt-responses-max-effort",
              status: "completed",
              output_text: "ok",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "ok" }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          },
        },
      ]);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "gpt-responses-max-effort",
        max_tokens: 256,
        stream: false,
        output_config: { effort: "max" },
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.content[0].text, "ok");
  });

  assertExists(upstreamBody);
  assertEquals(
    (upstreamBody!.reasoning as Record<string, unknown>).effort,
    "max",
  );
  assertEquals(upstreamBody!.include, ["reasoning.encrypted_content"]);
});

Deno.test("/v1/messages prefers responses on dual-endpoint models when native messages is unavailable", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        {
          id: "gpt-dual-endpoint",
          supported_endpoints: ["/responses", "/chat/completions"],
        },
      ]));
    }
    if (url.pathname === "/chat/completions") {
      throw new Error(
        "chat/completions should not be used when /responses is available",
      );
    }
    if (url.pathname === "/responses") {
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      upstreamBody = body;
      return sseResponse([
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              id: "resp_plain",
              object: "response",
              model: "gpt-dual-endpoint",
              status: "completed",
              output_text: "plain",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "plain" }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          },
        },
      ]);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "gpt-dual-endpoint",
        max_tokens: 256,
        stream: false,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.content[0].text, "plain");
  });

  assertExists(upstreamBody);
  assertFalse("reasoning" in upstreamBody!);
  assertFalse("include" in upstreamBody!);
});

Deno.test("stripReservedKeywords removes entire billing header line from string system", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "tok",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(
        copilotModels([{
          id: "claude-native",
          supported_endpoints: ["/v1/messages"],
        }]),
      );
    }
    if (url.pathname === "/v1/messages") {
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-native",
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
            delta: { type: "text_delta", text: "ok" },
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
            usage: { output_tokens: 1 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey.key },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 10,
        stream: false,
        system:
          "You are helpful.\nx-anthropic-billing-header: cc_version=2.1.114; cc_entrypoint=cli; cch=abcde12345;\nBe concise.",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    assertEquals(response.status, 200);
  });

  assertExists(upstreamBody);
  const sys = upstreamBody!.system as string;
  assertFalse(sys.includes("x-anthropic-billing-header"));
  assertFalse(sys.includes("cch="));
  assertEquals(sys.includes("You are helpful."), true);
  assertEquals(sys.includes("Be concise."), true);
});

Deno.test("stripReservedKeywords removes billing-only system block without 400 error", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "tok",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(
        copilotModels([{
          id: "claude-native",
          supported_endpoints: ["/v1/messages"],
        }]),
      );
    }
    if (url.pathname === "/v1/messages") {
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_2",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-native",
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
            content_block: { type: "text", text: "" },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
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
            usage: { output_tokens: 1 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey.key },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 10,
        stream: false,
        system: [
          {
            type: "text",
            text:
              "x-anthropic-billing-header: cc_version=2.1.114; cc_entrypoint=cli; cch=ff00ff00ff;",
          },
          {
            type: "text",
            text: "You are a helpful assistant.",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    assertEquals(response.status, 200);
  });

  assertExists(upstreamBody);
  const sys = upstreamBody!.system as Array<Record<string, unknown>>;
  assertEquals(sys.length, 1);
  assertEquals(sys[0].text, "You are a helpful assistant.");
  assertExists(sys[0].cache_control);
});

Deno.test("stripReservedKeywords handles all-billing system blocks by removing system entirely", async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "tok",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(
        copilotModels([{
          id: "claude-native",
          supported_endpoints: ["/v1/messages"],
        }]),
      );
    }
    if (url.pathname === "/v1/messages") {
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_3",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-native",
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
            content_block: { type: "text", text: "" },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
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
            usage: { output_tokens: 1 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey.key },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 10,
        stream: false,
        system: [
          {
            type: "text",
            text:
              "x-anthropic-billing-header: cc_version=2.1.114; cc_entrypoint=cli; cch=aabbccdd;",
          },
        ],
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    assertEquals(response.status, 200);
  });

  assertExists(upstreamBody);
  assertFalse("system" in upstreamBody!);
});

Deno.test("/v1/messages rewrites native web search to an upstream client tool without renaming web_search and returns pause_turn", async () => {
  const { apiKey } = await setupNativeWebSearchRouteTest();
  const capture: {
    upstreamBody?: Record<string, unknown>;
    upstreamBeta?: string | null;
    searchBody?: Record<string, unknown>;
  } = {};

  await withMockedFetch(
    makeNativeWebSearchUpstreamHandler({
      capture,
      upstreamResponse: makeAssistantSSE(
        "msg_native_search",
        [
          ...toolUseBlock(0, "toolu_1", "web_search", {
            query: "latest React docs",
          }),
        ],
      ),
    }),
    async () => {
      const response = await requestApp("/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.key,
        },
        body: JSON.stringify({
          model: "claude-native",
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          tool_choice: { type: "tool", name: "web_search" },
          messages: [{ role: "user", content: "latest React docs" }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.id, "msg_native_search");
      assertEquals(body.stop_reason, "pause_turn");
      assertEquals(body.content[0].type, "server_tool_use");
      assertEquals(body.content[1].type, "web_search_tool_result");
      assertEquals(body.usage.server_tool_use.web_search_requests, 1);
    },
  );

  assertExists(capture.upstreamBody);
  assertEquals(
    (capture.upstreamBody!.tools as Array<Record<string, unknown>>)[0].name,
    "web_search",
  );
  assertEquals(
    (capture.upstreamBody!.tools as Array<Record<string, unknown>>)[0]
      .description,
    "The web_search tool searches the internet and returns up-to-date information from web sources.",
  );
  assertEquals(
    (capture.upstreamBody!.tools as Array<Record<string, unknown>>)[0]
      .input_schema,
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
  );
  assertEquals(capture.upstreamBody!.tool_choice, {
    type: "tool",
    name: "web_search",
  });
  assertEquals(capture.searchBody?.query, "latest React docs");
});

Deno.test("/v1/messages keeps tool_use when native web search shares a turn with client tools", async () => {
  const { apiKey } = await setupNativeWebSearchRouteTest();
  const capture: {
    upstreamBody?: Record<string, unknown>;
    upstreamBeta?: string | null;
    searchBody?: Record<string, unknown>;
  } = {};

  await withMockedFetch(
    makeNativeWebSearchUpstreamHandler({
      capture,
      upstreamResponse: makeAssistantSSE(
        "msg_mixed_tools",
        [
          ...toolUseBlock(0, "toolu_1", "web_search", {
            query: "latest React docs",
          }),
          ...toolUseBlock(1, "toolu_2", "calc", { expression: "2+2" }),
        ],
        "tool_use",
      ),
    }),
    async () => {
      const response = await requestApp("/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.key,
        },
        body: JSON.stringify({
          model: "claude-native",
          max_tokens: 64,
          stream: false,
          tools: [
            makeWebSearchTool(),
            {
              name: "calc",
              description: "calculator",
              input_schema: { type: "object" },
            },
          ],
          messages: [{
            role: "user",
            content: "latest React docs and add 2+2",
          }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.stop_reason, "tool_use");
      assertEquals(
        body.content.some((block: { type: string }) =>
          block.type === "server_tool_use"
        ),
        true,
      );
      assertEquals(
        body.content.some((block: { type: string }) =>
          block.type === "tool_use"
        ),
        true,
      );
    },
  );

  assertExists(capture.upstreamBody);
  assertEquals(
    (capture.upstreamBody!.tools as Array<Record<string, unknown>>).map((
      tool,
    ) => tool.name),
    ["web_search", "calc"],
  );
  assertEquals(capture.searchBody?.query, "latest React docs");
});

Deno.test("/v1/messages returns internal debug error when native web search is disabled in config", async () => {
  const { apiKey } = await setupAppTest({
    searchConfig: {
      provider: "disabled",
      tavily: { apiKey: "" },
      microsoftGrounding: { apiKey: "" },
    },
  });

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }

    throw new Error(`Unexpected fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: false,
        tools: [makeWebSearchTool()],
        messages: [{ role: "user", content: "latest React docs" }],
      }),
    });

    assertEquals(response.status, 500);
    const body = await response.json();
    assertEquals(body.error.type, "internal_error");
    assertEquals(body.error.source_api, "messages");
    assertEquals(
      body.error.message,
      "Native Messages web search requires an enabled search provider.",
    );
    assertExists(body.error.stack);
  });
});

Deno.test("/v1/messages decodes our native-looking replay into upstream search_result history", async () => {
  const { apiKey } = await setupNativeWebSearchRouteTest();
  const capture: {
    upstreamBody?: Record<string, unknown>;
    upstreamBeta?: string | null;
  } = {};

  await withMockedFetch(
    makeNativeWebSearchUpstreamHandler({
      capture,
      upstreamResponse: makeAssistantSSE(
        "msg_replay_decoded",
        [...textBlock("Replay accepted.")],
      ),
    }),
    async () => {
      const response = await requestApp("/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.key,
        },
        body: JSON.stringify({
          model: "claude-native",
          max_tokens: 64,
          stream: false,
          messages: makeNativeSearchReplayMessages(),
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.content[0].text, "Replay accepted.");
    },
  );

  assertExists(capture.upstreamBody);
  const messages = capture.upstreamBody!.messages as Array<
    Record<string, unknown>
  >;
  assertEquals(messages.length, 3);
  const replayAssistantContent = messages[1].content as Array<
    Record<string, unknown>
  >;
  assertEquals(replayAssistantContent[0].type, "tool_use");
  assertEquals(
    ((replayAssistantContent[1] as { citations?: Array<{ type?: string }> })
      .citations?.[0])
      ?.type,
    "search_result_location",
  );
  assertEquals(
    ((messages[2].content as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >).type,
    "tool_result",
  );
});

Deno.test("/v1/messages leaves native-looking replay errors untouched even when native web search stays enabled", async () => {
  const { apiKey } = await setupNativeWebSearchRouteTest();
  const capture: { upstreamBody?: Record<string, unknown> } = {};

  await withMockedFetch(
    makeNativeWebSearchUpstreamHandler({
      capture,
      upstreamResponse: makeAssistantSSE(
        "msg_replay_error_passthrough",
        [...textBlock("Replay error passthrough accepted.")],
      ),
    }),
    async () => {
      const response = await requestApp("/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.key,
        },
        body: JSON.stringify({
          model: "claude-native",
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          messages: [
            ...makeNativeSearchErrorReplayMessages(),
            { role: "user", content: "What happened?" },
          ],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.content[0].text, "Replay error passthrough accepted.");
    },
  );

  assertExists(capture.upstreamBody);
  const messages = capture.upstreamBody!.messages as Array<
    Record<string, unknown>
  >;
  const replayAssistantContent = messages[1].content as Array<
    Record<string, unknown>
  >;
  assertEquals(replayAssistantContent[0].type, "server_tool_use");
  assertEquals(replayAssistantContent[1].type, "web_search_tool_result");
  assertEquals(
    (replayAssistantContent[1].content as Record<string, unknown>).type,
    "web_search_tool_result_error",
  );
});

Deno.test("/v1/messages passes through foreign native-looking history and preserves upstream 400", async () => {
  const { apiKey } = await setupAppTest();
  const capture: { upstreamBody?: Record<string, unknown> } = {};
  const upstreamError = {
    error: {
      type: "invalid_request_error",
      message: "foreign native history rejected",
    },
  };

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages") {
      capture.upstreamBody = JSON.parse(await request.text());
      return jsonResponse(upstreamError, 400);
    }

    throw new Error(`Unexpected fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: false,
        messages: makeForeignSearchReplayMessages(),
      }),
    });

    assertEquals(response.status, 400);
    assertEquals(await response.json(), upstreamError);
  });

  assertExists(capture.upstreamBody);
  const foreignAssistantContent =
    (capture.upstreamBody!.messages as Array<Record<string, unknown>>)[1]
      .content as Array<Record<string, unknown>>;
  assertEquals(foreignAssistantContent[0].type, "server_tool_use");
});

Deno.test("/v1/messages rejects duplicate native web search tools before upstream fetch", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }

    throw new Error(`Unexpected fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: false,
        tools: [
          { type: "web_search_20250305" },
          { type: "web_search_20260209" },
        ],
        messages: [{ role: "user", content: "latest React docs" }],
      }),
    });

    assertEquals(response.status, 400);
    assertEquals(await response.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Only one native web search tool definition is supported per request.",
      },
    });
  });
});

Deno.test("/v1/messages rejects native web search tools whose name is not web_search", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }

    throw new Error(`Unexpected fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: false,
        tools: [
          { type: "web_search_20260209", name: "WebSearch" },
        ],
        messages: [{ role: "user", content: "latest React docs" }],
      }),
    });

    assertEquals(response.status, 400);
    assertEquals(await response.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "tools.0.web_search_20260209.name: Input should be 'web_search'",
      },
    });
  });
});

Deno.test("/v1/messages rejects native web search tool name collisions before upstream fetch", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-native", supported_endpoints: ["/v1/messages"] },
      ]));
    }

    throw new Error(`Unexpected fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 64,
        stream: false,
        tools: [
          makeWebSearchTool(),
          {
            name: "web_search",
            description: "user-defined tool",
            input_schema: { type: "object" },
          },
        ],
        messages: [{ role: "user", content: "latest React docs" }],
      }),
    });

    assertEquals(response.status, 400);
    assertEquals(await response.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Native web search tool name collides with another client tool: web_search.",
      },
    });
  });
});
