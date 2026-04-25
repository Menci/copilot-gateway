import {
  assertEquals,
  assertExists,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  copilotModels,
  jsonResponse,
  parseSSEText,
  requestApp,
  setupAppTest,
  sseResponse,
  withMockedFetch,
} from "../../../../test-helpers.ts";

Deno.test("/v1/responses direct mode converts apply_patch and fixes mismatched stream item IDs", async () => {
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
        { id: "gpt-direct-responses", supported_endpoints: ["/responses"] },
      ]));
    }
    if (url.pathname === "/responses") {
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "item_orig",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "" }],
            },
          },
        },
        {
          event: "response.output_item.done",
          data: {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "item_wrong",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }],
            },
          },
        },
      ]);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "gpt-direct-responses",
        input: [{ type: "message", role: "user", content: "Patch this" }],
        instructions: null,
        temperature: 1,
        top_p: null,
        max_output_tokens: 32,
        tools: [{ type: "custom", name: "apply_patch" }],
        tool_choice: "auto",
        metadata: null,
        stream: true,
        store: false,
        parallel_tool_calls: true,
      }),
    });

    assertEquals(response.status, 200);
    const text = await response.text();
    const events = parseSSEText(text);
    assertEquals(events.length, 2);
    assertStringIncludes(events[1].data, '"id":"item_orig"');
  });

  assertExists(upstreamBody);
  const tool = (upstreamBody!.tools as Array<Record<string, unknown>>)[0];
  assertEquals(tool.type, "function");
  assertEquals(tool.name, "apply_patch");
  assertEquals((tool.parameters as Record<string, unknown>).type, "object");
});

Deno.test("/v1/responses direct mode synthesizes full Responses SSE when upstream falls back to JSON", async () => {
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
        {
          id: "gpt-direct-responses-json",
          supported_endpoints: ["/responses"],
        },
      ]));
    }
    if (url.pathname === "/responses") {
      return jsonResponse({
        id: "resp_json",
        object: "response",
        model: "gpt-direct-responses-json",
        status: "completed",
        output_text: "Hello",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello" }],
        }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "gpt-direct-responses-json",
        input: [{ type: "message", role: "user", content: "Hi" }],
        instructions: null,
        temperature: 1,
        top_p: null,
        max_output_tokens: 32,
        tools: null,
        tool_choice: "auto",
        metadata: null,
        stream: true,
        store: false,
        parallel_tool_calls: true,
      }),
    });

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "text/event-stream");

    const events = parseSSEText(await response.text());

    assertEquals(events.map((event) => event.event), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const created = JSON.parse(events[0].data) as Record<string, unknown>;
    const inProgress = JSON.parse(events[1].data) as Record<string, unknown>;
    const delta = JSON.parse(events[4].data) as Record<string, unknown>;
    const completed = JSON.parse(events[8].data) as Record<string, unknown>;

    assertEquals(created.sequence_number, 0);
    assertEquals(
      (created.response as Record<string, unknown>).status,
      "in_progress",
    );
    assertEquals((created.response as Record<string, unknown>).output, []);
    assertEquals(
      (created.response as Record<string, unknown>).output_text,
      "",
    );
    assertFalse("error" in (created.response as Record<string, unknown>));
    assertFalse(
      "incomplete_details" in (created.response as Record<string, unknown>),
    );
    assertEquals((inProgress.response as Record<string, unknown>).output, []);
    assertEquals(
      (inProgress.response as Record<string, unknown>).output_text,
      "",
    );
    assertEquals(delta.sequence_number, 4);
    assertEquals(delta.delta, "Hello");
    assertEquals(
      (completed.response as Record<string, unknown>).status,
      "completed",
    );
    assertEquals(
      (completed.response as Record<string, unknown>).output_text,
      "Hello",
    );
  });
});

Deno.test("/v1/responses direct mode retries connection-bound input item IDs once with a rewritten ID", async () => {
  const { apiKey } = await setupAppTest();

  const requests: Record<string, unknown>[] = [];
  const originalId = btoa("0123456789abcdefghij");

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
          id: "gpt-direct-responses-retry",
          supported_endpoints: ["/responses"],
        },
      ]));
    }
    if (url.pathname === "/responses") {
      requests.push(JSON.parse(await request.text()));

      return requests.length === 1
        ? jsonResponse({
          error: {
            message: "input item ID does not belong to this connection",
          },
        }, 400)
        : jsonResponse({
          id: "resp_retry",
          object: "response",
          model: "gpt-direct-responses-retry",
          status: "completed",
          output_text: "ok",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "gpt-direct-responses-retry",
        input: [{
          type: "message",
          id: originalId,
          role: "user",
          content: "Hi",
        }],
        instructions: null,
        temperature: 1,
        top_p: null,
        max_output_tokens: 32,
        tools: null,
        tool_choice: "auto",
        metadata: null,
        stream: false,
        store: false,
        parallel_tool_calls: true,
      }),
    });

    assertEquals(response.status, 200);
    assertEquals((await response.json()).id, "resp_retry");
  });

  assertEquals(requests.length, 2);

  const firstInput = requests[0].input as Array<Record<string, unknown>>;
  const secondInput = requests[1].input as Array<Record<string, unknown>>;

  assertEquals(firstInput[0].id, originalId);
  assertStringIncludes(secondInput[0].id as string, "msg_");
});

Deno.test("/v1/responses malformed JSON returns structured internal debug error", async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey.key,
    },
    body: "{",
  });

  assertEquals(response.status, 502);

  const body = await response.json();
  assertEquals(body.error.type, "internal_error");
  assertEquals(body.error.name, "SyntaxError");
  assertEquals(body.error.source_api, "responses");
  assertExists(body.error.stack);
});

Deno.test("/v1/responses falls back to chat completions for chat-only models", async () => {
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
          id: "gpt-chat-only-responses",
          supported_endpoints: ["/chat/completions"],
        },
      ]));
    }
    if (url.pathname === "/chat/completions") {
      upstreamBody = JSON.parse(await request.text());
      return jsonResponse({
        id: "chatcmpl_resp_only",
        object: "chat.completion",
        created: 1,
        model: "gpt-chat-only-responses",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "Hello from chat",
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "gpt-chat-only-responses",
        input: [{ type: "message", role: "user", content: "Hi" }],
        instructions: "system prompt",
        temperature: 0.7,
        top_p: 0.8,
        max_output_tokens: 128,
        tools: null,
        tool_choice: "auto",
        metadata: null,
        stream: false,
        store: false,
        parallel_tool_calls: true,
      }),
    });

    assertEquals(response.status, 200);

    const body = await response.json();
    assertEquals(body.status, "completed");
    assertEquals(body.output_text, "Hello from chat");
    assertEquals(body.output[0].type, "message");
    assertEquals(body.output[0].content[0].text, "Hello from chat");
  });

  assertExists(upstreamBody);
  const messages = upstreamBody!.messages as Array<Record<string, unknown>>;
  assertEquals(upstreamBody!.model, "gpt-chat-only-responses");
  assertEquals(messages[0].role, "system");
  assertEquals(messages[0].content, "system prompt");
  assertEquals(messages[1].role, "user");
  assertEquals(messages[1].content, "Hi");
  assertEquals(upstreamBody!.max_tokens, 128);
});

Deno.test("/v1/responses streams chat completions as Responses SSE for chat-only models", async () => {
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
        {
          id: "gpt-chat-only-stream",
          supported_endpoints: ["/chat/completions"],
        },
      ]));
    }
    if (url.pathname === "/chat/completions") {
      return sseResponse([
        {
          data: {
            id: "chatcmpl_stream_only",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-chat-only-stream",
            choices: [{
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            }],
          },
        },
        {
          data: {
            id: "chatcmpl_stream_only",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-chat-only-stream",
            choices: [{
              index: 0,
              delta: { content: "Hello" },
              finish_reason: null,
            }],
          },
        },
        {
          data: {
            id: "chatcmpl_stream_only",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-chat-only-stream",
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop",
            }],
          },
        },
        {
          data: {
            id: "chatcmpl_stream_only",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-chat-only-stream",
            choices: [],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
            },
          },
        },
        { data: "[DONE]" },
      ]);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "gpt-chat-only-stream",
        input: [{ type: "message", role: "user", content: "Hi" }],
        instructions: null,
        temperature: 1,
        top_p: null,
        max_output_tokens: 64,
        tools: null,
        tool_choice: "auto",
        metadata: null,
        stream: true,
        store: false,
        parallel_tool_calls: true,
      }),
    });

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "text/event-stream");

    const events = parseSSEText(await response.text());

    assertEquals(events.map((event) => event.event), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const delta = JSON.parse(events[4].data) as Record<string, unknown>;
    const completed = JSON.parse(events[8].data) as Record<string, unknown>;

    assertEquals(delta.delta, "Hello");
    assertEquals(
      (completed.response as Record<string, unknown>).output_text,
      "Hello",
    );
    assertEquals(
      ((completed.response as Record<string, unknown>).usage as Record<
        string,
        unknown
      >).output_tokens,
      4,
    );
  });
});

Deno.test("/v1/responses via messages fills missing max_tokens from model limits", async () => {
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
      return jsonResponse({
        object: "list",
        data: [{
          id: "claude-via-messages-limit",
          name: "claude-via-messages-limit",
          version: "1",
          object: "model",
          supported_endpoints: ["/v1/messages"],
          capabilities: {
            family: "test",
            type: "chat",
            limits: { max_output_tokens: 4096 },
            supports: {},
          },
        }],
      });
    }
    if (url.pathname === "/v1/messages") {
      upstreamBody = JSON.parse(await request.text());
      return sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_limit",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-via-messages-limit",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
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
    const response = await requestApp("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-via-messages-limit",
        input: [{ type: "message", role: "user", content: "Hi" }],
        instructions: null,
        temperature: 1,
        top_p: null,
        max_output_tokens: null,
        tools: null,
        tool_choice: "auto",
        metadata: null,
        stream: false,
        store: false,
        parallel_tool_calls: true,
      }),
    });

    assertEquals(response.status, 200);
    assertEquals((await response.json()).status, "completed");
  });

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.max_tokens, 4096);
});

Deno.test("/v1/responses prefers messages over chat completions when both translated paths are available", async () => {
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
          id: "claude-via-messages",
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
              id: "msg_123",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-via-messages",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 11, output_tokens: 0 },
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
            delta: { type: "text_delta", text: "Hello" },
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
            usage: { output_tokens: 9 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-via-messages",
        input: [{ type: "message", role: "user", content: "Hi" }],
        instructions: null,
        temperature: 1,
        top_p: null,
        max_output_tokens: null,
        tools: [{ type: "custom", name: "apply_patch" }],
        tool_choice: "auto",
        metadata: null,
        stream: true,
        store: false,
        parallel_tool_calls: true,
      }),
    });

    assertEquals(response.status, 200);
    const text = await response.text();
    const events = parseSSEText(text);

    assertEquals(events[0].event, "response.created");
    assertEquals(events[1].event, "response.in_progress");
    assertEquals(events[4].event, "response.output_text.delta");
    assertEquals(events[events.length - 1].event, "response.completed");

    const first = JSON.parse(events[0].data) as Record<string, unknown>;
    const delta = JSON.parse(events[4].data) as Record<string, unknown>;
    const completed = JSON.parse(events[events.length - 1].data) as Record<
      string,
      unknown
    >;

    assertEquals(first.sequence_number, 0);
    assertEquals(delta.sequence_number, 4);
    assertEquals(
      (completed.response as Record<string, unknown>).status,
      "completed",
    );
    assertEquals(
      ((completed.response as Record<string, unknown>).usage as Record<
        string,
        unknown
      >).output_tokens,
      9,
    );
  });

  assertExists(upstreamBody);
  assertEquals(
    (upstreamBody!.tools as Array<Record<string, unknown>>)[0].name,
    "apply_patch",
  );
  assertEquals(upstreamBody!.max_tokens, 8192);
  assertEquals(upstreamBody!.stream, true);
});
