import type { Context } from "hono";
import type { AnthropicMessagesPayload } from "../lib/anthropic-types.ts";

type TokenCountFn = (text: string) => number;

let anthropicTokenizer: TokenCountFn | null = null;
let gptTokenizer: TokenCountFn | null = null;

async function getAnthropicTokenizer(): Promise<TokenCountFn> {
  if (anthropicTokenizer) return anthropicTokenizer;
  const mod = await import("@anthropic-ai/tokenizer");
  anthropicTokenizer = mod.countTokens;
  return anthropicTokenizer;
}

async function getGptTokenizer(): Promise<TokenCountFn> {
  if (gptTokenizer) return gptTokenizer;
  const mod = await import("gpt-tokenizer/encoding/o200k_base");
  gptTokenizer = (text: string) => mod.encode(text).length;
  return gptTokenizer;
}

const estimateTokens: TokenCountFn = (text) => Math.ceil(text.length / 3.5);

async function getTokenCounter(model: string): Promise<TokenCountFn> {
  if (model.startsWith("claude")) {
    try { return await getAnthropicTokenizer(); }
    catch (e) { console.warn("Failed to load Anthropic tokenizer, using estimation:", e); return estimateTokens; }
  }
  if (/^(gpt|o[1-9]|codex)/.test(model)) {
    try { return await getGptTokenizer(); }
    catch (e) { console.warn("Failed to load GPT tokenizer, using estimation:", e); return estimateTokens; }
  }
  return estimateTokens;
}

function extractPayloadText(payload: AnthropicMessagesPayload): string {
  const parts: string[] = [];

  if (payload.system) {
    if (typeof payload.system === "string") parts.push(payload.system);
    else for (const block of payload.system) parts.push(block.text);
  }

  for (const msg of payload.messages) {
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "thinking" && "thinking" in block) parts.push(block.thinking);
        else if (block.type === "tool_use" && "input" in block) parts.push(JSON.stringify(block.input));
        else if (block.type === "tool_result" && "content" in block && typeof block.content === "string") parts.push(block.content);
      }
    }
  }

  if (payload.tools) {
    for (const tool of payload.tools) {
      parts.push(tool.name);
      if (tool.description) parts.push(tool.description);
      parts.push(JSON.stringify(tool.input_schema));
    }
  }

  return parts.join("\n");
}

async function countPayloadTokens(payload: AnthropicMessagesPayload): Promise<number> {
  const countFn = await getTokenCounter(payload.model);
  let total = countFn(extractPayloadText(payload));

  // Structural overhead: role markers, message boundaries (~4 tokens each)
  total += payload.messages.length * 4;

  // Image tokens (rough estimate, not counted by text tokenizer)
  for (const msg of payload.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "image") total += 1000;
      }
    }
  }

  return Math.max(total, 1);
}

export const countTokens = async (c: Context) => {
  try {
    const payload = await c.req.json<AnthropicMessagesPayload>();
    return c.json({ input_tokens: await countPayloadTokens(payload) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Error counting tokens:", msg);
    return c.json({ error: { type: "invalid_request_error", message: `Failed to count tokens: ${msg}` } }, 400);
  }
};
