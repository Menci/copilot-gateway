import { assertEquals, assertExists } from "@std/assert";
import { translateChatToMessages } from "./chat-to-messages.ts";
import type { ChatCompletionsPayload } from "../openai-types.ts";
import type {
  AnthropicAssistantContentBlock,
  AnthropicRedactedThinkingBlock,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
} from "../anthropic-types.ts";

// ── Helpers ──

function mkPayload(overrides: Partial<ChatCompletionsPayload> & { messages: ChatCompletionsPayload["messages"] }): ChatCompletionsPayload {
  return { model: "claude-sonnet-4", ...overrides };
}

function assistantBlocks(result: ReturnType<typeof translateChatToMessages>, msgIndex = 0): AnthropicAssistantContentBlock[] {
  const msg = result.messages[msgIndex];
  assertEquals(msg.role, "assistant");
  return msg.content as AnthropicAssistantContentBlock[];
}

function userBlocks(result: ReturnType<typeof translateChatToMessages>, msgIndex = 0): AnthropicUserContentBlock[] {
  const msg = result.messages[msgIndex];
  assertEquals(msg.role, "user");
  return Array.isArray(msg.content) ? msg.content as AnthropicUserContentBlock[] : [{ type: "text", text: msg.content as string }];
}

// ── System / Developer messages ──

Deno.test("system message extracted to system field", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ],
  }));
  assertEquals(result.system, "You are helpful.");
  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, "user");
});

Deno.test("developer message treated same as system", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "developer", content: "Dev instructions" },
      { role: "user", content: "Hi" },
    ],
  }));
  assertEquals(result.system, "Dev instructions");
});

Deno.test("multiple system messages joined with double newline", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "system", content: "First" },
      { role: "developer", content: "Second" },
      { role: "user", content: "Hi" },
    ],
  }));
  assertEquals(result.system, "First\n\nSecond");
});

Deno.test("empty system content is skipped", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "system", content: "" },
      { role: "user", content: "Hi" },
    ],
  }));
  assertEquals(result.system, undefined);
});

Deno.test("system with ContentPart array extracts text parts", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "system", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
      { role: "user", content: "Hi" },
    ],
  }));
  assertEquals(result.system, "AB");
});

// ── Basic message mapping ──

Deno.test("simple user message → string content", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hello" }],
  }));
  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, "user");
  assertEquals(result.messages[0].content, "Hello");
});

Deno.test("simple assistant message → text block", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "text");
  assertEquals((blocks[0] as AnthropicTextBlock).text, "Hello!");
});

Deno.test("assistant with null content → empty text block", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: null },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "text");
  assertEquals((blocks[0] as AnthropicTextBlock).text, "");
});

Deno.test("user with null content → empty text block", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: null }],
  }));
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  assertEquals((blocks[0] as AnthropicTextBlock).text, "");
});

// ── User/user merge ──

Deno.test("consecutive user messages merged", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "First" },
      { role: "user", content: "Second" },
    ],
  }));
  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, "user");
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 2);
  assertEquals((blocks[0] as AnthropicTextBlock).text, "First");
  assertEquals((blocks[1] as AnthropicTextBlock).text, "Second");
});

Deno.test("three consecutive users all merged into one", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "A" },
      { role: "user", content: "B" },
      { role: "user", content: "C" },
    ],
  }));
  assertEquals(result.messages.length, 1);
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 3);
});

// ── Tool messages ──

Deno.test("tool message creates user with tool_result block", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", content: "result", tool_call_id: "tc1" },
    ],
  }));
  assertEquals(result.messages.length, 3);
  assertEquals(result.messages[2].role, "user");
  const blocks = result.messages[2].content as AnthropicUserContentBlock[];
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "tool_result");
  assertEquals((blocks[0] as AnthropicToolResultBlock).tool_use_id, "tc1");
  assertEquals((blocks[0] as AnthropicToolResultBlock).content, "result");
});

Deno.test("multiple tool messages after assistant merged into one user", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: null, tool_calls: [
        { id: "tc1", type: "function", function: { name: "f1", arguments: "{}" } },
        { id: "tc2", type: "function", function: { name: "f2", arguments: "{}" } },
      ] },
      { role: "tool", content: "r1", tool_call_id: "tc1" },
      { role: "tool", content: "r2", tool_call_id: "tc2" },
    ],
  }));
  // user, assistant, user(tool_result, tool_result)
  assertEquals(result.messages.length, 3);
  assertEquals(result.messages[2].role, "user");
  const blocks = result.messages[2].content as AnthropicUserContentBlock[];
  assertEquals(blocks.length, 2);
  assertEquals((blocks[0] as AnthropicToolResultBlock).tool_use_id, "tc1");
  assertEquals((blocks[1] as AnthropicToolResultBlock).tool_use_id, "tc2");
});

Deno.test("tool + user merged: tool_results + text in same user msg", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", content: "result", tool_call_id: "tc1" },
      { role: "user", content: "thanks" },
    ],
  }));
  // user, assistant, user([tool_result, text("thanks")])
  assertEquals(result.messages.length, 3);
  const blocks = result.messages[2].content as AnthropicUserContentBlock[];
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, "tool_result");
  assertEquals(blocks[1].type, "text");
  assertEquals((blocks[1] as AnthropicTextBlock).text, "thanks");
});

Deno.test("tool message without tool_call_id uses empty string", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", content: "result" },
    ],
  }));
  const blocks = result.messages[2].content as AnthropicUserContentBlock[];
  assertEquals((blocks[0] as AnthropicToolResultBlock).tool_use_id, "");
});

// ── Assistant content block ordering ──

Deno.test("assistant blocks ordered: thinking → text → tool_use", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: "response text",
        reasoning_text: "I think...",
        reasoning_opaque: "sig123",
        tool_calls: [{ id: "tc1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
      },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 3);
  assertEquals(blocks[0].type, "thinking");
  assertEquals(blocks[1].type, "text");
  assertEquals(blocks[2].type, "tool_use");
});

Deno.test("assistant with only tool_calls, no content", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
      },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "tool_use");
  assertEquals((blocks[0] as AnthropicToolUseBlock).name, "f");
  assertEquals((blocks[0] as AnthropicToolUseBlock).input, { a: 1 });
});

Deno.test("assistant with multiple tool_calls", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "f1", arguments: '{"x":1}' } },
          { id: "tc2", type: "function", function: { name: "f2", arguments: '{"y":2}' } },
        ],
      },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, "tool_use");
  assertEquals(blocks[1].type, "tool_use");
  assertEquals((blocks[0] as AnthropicToolUseBlock).id, "tc1");
  assertEquals((blocks[1] as AnthropicToolUseBlock).id, "tc2");
});

Deno.test("assistant tool_calls with invalid JSON arguments → raw_arguments fallback", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "not json" } }],
      },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  assertEquals((blocks[0] as AnthropicToolUseBlock).input, { raw_arguments: "not json" });
});

// ── Thinking / Redacted thinking ──

Deno.test("reasoning_text + reasoning_opaque → thinking block with signature", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "resp", reasoning_text: "My thoughts", reasoning_opaque: "sig" },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  const thinking = blocks[0] as AnthropicThinkingBlock;
  assertEquals(thinking.type, "thinking");
  assertEquals(thinking.thinking, "My thoughts");
  assertEquals(thinking.signature, "sig");
});

Deno.test("reasoning_text only → thinking block without signature", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "resp", reasoning_text: "My thoughts" },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  const thinking = blocks[0] as AnthropicThinkingBlock;
  assertEquals(thinking.type, "thinking");
  assertEquals(thinking.thinking, "My thoughts");
  assertEquals(thinking.signature, undefined);
});

Deno.test("reasoning_opaque only → redacted_thinking block", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "resp", reasoning_opaque: "opaque_data" },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  const redacted = blocks[0] as AnthropicRedactedThinkingBlock;
  assertEquals(redacted.type, "redacted_thinking");
  assertEquals(redacted.data, "opaque_data");
});

Deno.test("no reasoning fields → no thinking block", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "resp" },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "text");
});

Deno.test("null reasoning fields → no thinking block", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "resp", reasoning_text: null, reasoning_opaque: null },
    ],
  }));
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "text");
});

// ── Image handling ──

Deno.test("image_url with data URL → base64 image block", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    }],
  }));
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, "text");
  assertEquals(blocks[1].type, "image");
  const img = blocks[1] as { type: "image"; source: { type: string; media_type: string; data: string } };
  assertEquals(img.source.type, "base64");
  assertEquals(img.source.media_type, "image/png");
  assertEquals(img.source.data, "iVBORw0KGgo=");
});

Deno.test("image_url with non-data URL is skipped", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What?" },
        { type: "image_url", image_url: { url: "https://example.com/img.png" } },
      ],
    }],
  }));
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "text");
});

Deno.test("image with jpeg media type", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ=" } },
      ],
    }],
  }));
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  const img = blocks[0] as { type: "image"; source: { media_type: string } };
  assertEquals(img.source.media_type, "image/jpeg");
});

Deno.test("content with only non-parseable image → empty text fallback", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "not-a-data-url" } },
      ],
    }],
  }));
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, "text");
  assertEquals((blocks[0] as AnthropicTextBlock).text, "");
});

// ── Field mapping ──

Deno.test("max_tokens defaults to 8192 when not provided", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
  }));
  assertEquals(result.max_tokens, 8192);
});

Deno.test("max_tokens passed through when provided", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 1024,
  }));
  assertEquals(result.max_tokens, 1024);
});

Deno.test("temperature mapped", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    temperature: 0.7,
  }));
  assertEquals(result.temperature, 0.7);
});

Deno.test("temperature 0 is mapped (not treated as falsy)", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    temperature: 0,
  }));
  assertEquals(result.temperature, 0);
});

Deno.test("top_p mapped", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    top_p: 0.9,
  }));
  assertEquals(result.top_p, 0.9);
});

Deno.test("null temperature/top_p not included", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    temperature: null,
    top_p: null,
  }));
  assertEquals(result.temperature, undefined);
  assertEquals(result.top_p, undefined);
});

Deno.test("stop string → stop_sequences array", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    stop: "END",
  }));
  assertEquals(result.stop_sequences, ["END"]);
});

Deno.test("stop array → stop_sequences array", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    stop: ["END", "STOP"],
  }));
  assertEquals(result.stop_sequences, ["END", "STOP"]);
});

Deno.test("stream flag passed through", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
  }));
  assertEquals(result.stream, true);
});

Deno.test("stream false → not set", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    stream: false,
  }));
  assertEquals(result.stream, undefined);
});

Deno.test("thinking_budget → thinking config", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    thinking_budget: 4096,
  }));
  assertEquals(result.thinking, { type: "enabled", budget_tokens: 4096 });
});

Deno.test("no thinking_budget → no thinking config", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
  }));
  assertEquals(result.thinking, undefined);
});

// ── Tool choice mapping ──

Deno.test("tool_choice auto → { type: auto }", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    tool_choice: "auto",
  }));
  assertEquals(result.tool_choice, { type: "auto" });
});

Deno.test("tool_choice none → { type: none }", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    tool_choice: "none",
  }));
  assertEquals(result.tool_choice, { type: "none" });
});

Deno.test("tool_choice required → { type: any }", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    tool_choice: "required",
  }));
  assertEquals(result.tool_choice, { type: "any" });
});

Deno.test("tool_choice specific function → { type: tool, name }", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    tool_choice: { type: "function", function: { name: "get_weather" } },
  }));
  assertEquals(result.tool_choice, { type: "tool", name: "get_weather" });
});

Deno.test("null tool_choice → not set", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    tool_choice: null,
  }));
  assertEquals(result.tool_choice, undefined);
});

// ── Tools mapping ──

Deno.test("tools translated correctly", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    }],
  }));
  assertExists(result.tools);
  assertEquals(result.tools!.length, 1);
  assertEquals(result.tools![0].name, "get_weather");
  assertEquals(result.tools![0].description, "Get weather");
  assertEquals(result.tools![0].input_schema, { type: "object", properties: { city: { type: "string" } } });
});

Deno.test("empty tools array → not set", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
  }));
  assertEquals(result.tools, undefined);
});

// ── Model passthrough ──

Deno.test("model name passed through", () => {
  const result = translateChatToMessages(mkPayload({
    model: "claude-opus-4",
    messages: [{ role: "user", content: "Hi" }],
  }));
  assertEquals(result.model, "claude-opus-4");
});

// ── Complex multi-turn conversations ──

Deno.test("full tool use round-trip conversation", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What is the weather?" },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "tc1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }],
      },
      { role: "tool", content: '{"temp":20}', tool_call_id: "tc1" },
      { role: "assistant", content: "It's 20 degrees in Tokyo." },
    ],
  }));
  assertEquals(result.system, "You are helpful.");
  assertEquals(result.messages.length, 4);
  assertEquals(result.messages[0].role, "user");
  assertEquals(result.messages[1].role, "assistant");
  assertEquals(result.messages[2].role, "user");
  assertEquals(result.messages[3].role, "assistant");
  // msg[2] should have tool_result
  const trBlocks = result.messages[2].content as AnthropicUserContentBlock[];
  assertEquals(trBlocks[0].type, "tool_result");
});

Deno.test("interleaved thinking round-trip", () => {
  const result = translateChatToMessages(mkPayload({
    messages: [
      { role: "user", content: "Solve this." },
      {
        role: "assistant",
        content: null,
        reasoning_text: "thinking1",
        reasoning_opaque: "sig1",
        tool_calls: [{ id: "tc1", type: "function", function: { name: "calc", arguments: '{"x":1}' } }],
      },
      { role: "tool", content: "42", tool_call_id: "tc1" },
      {
        role: "assistant",
        content: "The answer is 42.",
        reasoning_text: "thinking2",
        reasoning_opaque: "sig2",
      },
    ],
  }));
  assertEquals(result.messages.length, 4);

  // First assistant: thinking → tool_use
  const a1 = assistantBlocks(result, 1);
  assertEquals(a1[0].type, "thinking");
  assertEquals(a1[1].type, "tool_use");

  // Second assistant: thinking → text
  const a2 = assistantBlocks(result, 3);
  assertEquals(a2[0].type, "thinking");
  assertEquals(a2[1].type, "text");
});
