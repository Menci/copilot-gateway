import { assertEquals, assertExists, assertFalse } from "@std/assert";
import type { ResponsesResult } from "../lib/responses-types.ts";
import {
  copilotModels,
  jsonResponse,
  parseSSEText,
  requestApp,
  setupAppTest,
  sseResponse,
  withMockedFetch,
} from "../test-helpers.ts";

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
        system: "system x-anthropic-billing-header note",
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
  assertEquals(upstreamBody!.system, "system  note");
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
    "hello  world",
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

Deno.test("/v1/messages forwards Anthropic tool strict field on native messages", async () => {
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

Deno.test("/v1/messages retries native requests with downgraded output_config.effort", async () => {
  const { apiKey } = await setupAppTest();

  const upstreamBodies: Array<Record<string, unknown>> = [];

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
        { id: "claude-native-reasoning", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages") {
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      upstreamBodies.push(body);

      const outputConfig = body.output_config as Record<string, unknown> | undefined;
      if (outputConfig?.effort === "xhigh") {
        return jsonResponse({
          error: {
            message:
              'output_config.effort "xhigh" is not supported by model claude-native-reasoning; supported values: [medium]',
            code: "invalid_reasoning_effort",
          },
        }, 400);
      }

      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_reasoning",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-native-reasoning",
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
        model: "claude-native-reasoning",
        max_tokens: 64,
        stream: false,
        thinking: { type: "enabled", budget_tokens: 4096 },
        output_config: { effort: "xhigh" },
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.id, "msg_reasoning");
  });

  assertEquals(upstreamBodies.length, 2);
  assertEquals(
    ((upstreamBodies[0].output_config as Record<string, unknown>).effort),
    "xhigh",
  );
  assertEquals(
    ((upstreamBodies[1].output_config as Record<string, unknown>).effort),
    "medium",
  );
  assertEquals(
    ((upstreamBodies[1].thinking as Record<string, unknown>).budget_tokens),
    4096,
  );
});

Deno.test("/v1/messages keeps strict Anthropic tools on native messages when both endpoints are available", async () => {
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
        "chat fallback should not be used for strict Anthropic tools",
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

Deno.test("/v1/messages with budgeted thinking prefers responses on dual-endpoint models and picks the nearest supported effort", async () => {
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
        "chat/completions should not be used for budgeted thinking",
      );
    }
    if (url.pathname === "/responses") {
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      if ((body.max_output_tokens as number | undefined) === 1) {
        const reasoning = body.reasoning as Record<string, unknown> | undefined;
        if (!reasoning) return jsonResponse({ ok: true });
        const effort = reasoning.effort;
        return effort === "low" || effort === "medium"
          ? jsonResponse({ ok: true })
          : jsonResponse({ error: { message: "unsupported effort" } }, 400);
      }

      upstreamBody = body;
      return sseResponse([
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              id: "resp_dual",
              object: "response",
              model: "gpt-dual-endpoint",
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
        model: "gpt-dual-endpoint",
        max_tokens: 256,
        stream: false,
        thinking: { type: "enabled", budget_tokens: 21332 },
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.content[0].text, "ok");
  });

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertEquals(
    (upstreamBody!.reasoning as Record<string, unknown>).effort,
    "medium",
  );
  const input = upstreamBody!.input as Array<Record<string, unknown>>;
  assertEquals((input[0] as Record<string, unknown>).type, "message");
});

Deno.test("/v1/messages drops reasoning config when the responses endpoint supports no reasoning efforts", async () => {
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
          id: "gpt-no-reasoning",
          supported_endpoints: ["/responses", "/chat/completions"],
        },
      ]));
    }
    if (url.pathname === "/chat/completions") {
      throw new Error(
        "chat/completions should not be used for budgeted thinking",
      );
    }
    if (url.pathname === "/responses") {
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      if ((body.max_output_tokens as number | undefined) === 1) {
        return body.reasoning
          ? jsonResponse({ error: { message: "unsupported effort" } }, 400)
          : jsonResponse({ ok: true });
      }

      upstreamBody = body;
      return sseResponse([
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              id: "resp_plain",
              object: "response",
              model: "gpt-no-reasoning",
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
        model: "gpt-no-reasoning",
        max_tokens: 256,
        stream: false,
        thinking: { type: "enabled", budget_tokens: 4096 },
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
