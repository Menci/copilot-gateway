// Chat Completions → Anthropic Messages request translation

import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicRedactedThinkingBlock,
  AnthropicThinkingBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "../anthropic-types.ts";
import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "../openai-types.ts";
import { safeJsonParse } from "./utils.ts";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

interface RemoteImageData {
  mediaType: string | null;
  data: Uint8Array;
}

export type RemoteImageLoader = (
  url: string,
) => Promise<RemoteImageData | null>;

interface TranslateChatToMessagesOptions {
  loadRemoteImage?: RemoteImageLoader;
}

export async function translateChatToMessages(
  payload: ChatCompletionsPayload,
  options: TranslateChatToMessagesOptions = {},
): Promise<AnthropicMessagesPayload> {
  const systemParts: string[] = [];
  const nonSystemMessages: Message[] = [];

  for (const msg of payload.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
        ? msg.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
        : "";
      if (text) systemParts.push(text);
    } else {
      nonSystemMessages.push(msg);
    }
  }

  const anthropicMessages = await buildMessages(
    nonSystemMessages,
    options.loadRemoteImage ?? fetchRemoteImage,
  );

  const result: AnthropicMessagesPayload = {
    model: payload.model,
    messages: anthropicMessages,
    max_tokens: payload.max_tokens ?? 8192,
  };

  if (systemParts.length > 0) {
    result.system = systemParts.join("\n\n");
  }
  if (payload.temperature != null) {
    result.temperature = payload.temperature;
  }
  if (payload.top_p != null) {
    result.top_p = payload.top_p;
  }
  if (payload.stop != null) {
    result.stop_sequences = Array.isArray(payload.stop)
      ? payload.stop
      : [payload.stop];
  }
  if (payload.stream) {
    result.stream = payload.stream;
  }
  if (payload.tools && payload.tools.length > 0) {
    result.tools = translateTools(payload.tools);
  }
  if (payload.tool_choice != null) {
    result.tool_choice = translateToolChoice(payload.tool_choice);
  }

  return result;
}

async function buildMessages(
  messages: Message[],
  loadRemoteImage: RemoteImageLoader,
): Promise<AnthropicMessage[]> {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        appendUserContent(
          result,
          await convertUserContent(msg, loadRemoteImage),
        );
        break;
      case "assistant":
        result.push({ role: "assistant", content: buildAssistantBlocks(msg) });
        break;
      case "tool":
        appendToolResult(result, {
          type: "tool_result",
          tool_use_id: msg.tool_call_id ?? "",
          content: typeof msg.content === "string" ? msg.content : "",
        });
        break;
    }
  }

  return result;
}

/** Append user content blocks, merging with the last message if it's also a user message. */
function appendUserContent(
  result: AnthropicMessage[],
  blocks: AnthropicUserContentBlock[],
): void {
  const last = result[result.length - 1];
  if (last?.role === "user") {
    const existing = Array.isArray(last.content)
      ? last.content
      : [{ type: "text" as const, text: last.content as string }];
    (last as { role: "user"; content: AnthropicUserContentBlock[] }).content = [
      ...existing,
      ...blocks,
    ];
  } else {
    result.push({
      role: "user",
      content: blocks.length === 1 && blocks[0].type === "text"
        ? blocks[0].text
        : blocks,
    });
  }
}

/** Append a tool_result block to the last user message, or create a new one. */
function appendToolResult(
  result: AnthropicMessage[],
  toolResult: AnthropicToolResultBlock,
): void {
  const last = result[result.length - 1];
  if (last?.role === "user") {
    const existing = Array.isArray(last.content)
      ? last.content
      : [{ type: "text" as const, text: last.content as string }];
    (last as { role: "user"; content: AnthropicUserContentBlock[] }).content = [
      ...existing,
      toolResult,
    ];
  } else {
    result.push({ role: "user", content: [toolResult] });
  }
}

async function convertUserContent(
  msg: Message,
  loadRemoteImage: RemoteImageLoader,
): Promise<AnthropicUserContentBlock[]> {
  if (typeof msg.content === "string") {
    return [{ type: "text", text: msg.content }];
  }
  if (!Array.isArray(msg.content)) {
    return [{ type: "text", text: "" }];
  }

  const resolved = await Promise.all(
    (msg.content as ContentPart[]).map((part) => {
      if (part.type === "text") {
        return Promise.resolve(
          {
            type: "text" as const,
            text: part.text,
          } as AnthropicUserContentBlock,
        );
      }
      if (part.type === "image_url") {
        return resolveImage(part.image_url.url, loadRemoteImage);
      }
      return Promise.resolve(null);
    }),
  );

  const blocks = resolved.filter((b): b is AnthropicUserContentBlock =>
    b !== null
  );
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/** Resolve an image URL to an Anthropic image block. Supports data: URLs and HTTP(S) fetch. */
async function resolveImage(
  url: string,
  loadRemoteImage: RemoteImageLoader,
): Promise<AnthropicImageBlock | null> {
  // Fast path: data: URL (no fetch needed)
  const dataUrl = parseDataUrl(url);
  if (dataUrl) {
    if (!ALLOWED_IMAGE_TYPES.has(dataUrl.mediaType)) return null;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataUrl
          .mediaType as AnthropicImageBlock["source"]["media_type"],
        data: dataUrl.data,
      },
    };
  }

  // HTTP(S) fetch
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  return await resolveRemoteImage(url, loadRemoteImage);
}

async function resolveRemoteImage(
  url: string,
  loadRemoteImage: RemoteImageLoader,
): Promise<AnthropicImageBlock | null> {
  const image = await loadRemoteImage(url);
  if (!image) return null;

  let mediaType = image.mediaType?.split(";")[0].trim() ?? "";
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
    mediaType = inferMediaTypeFromUrl(url) ?? "";
  }
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) return null;

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType as AnthropicImageBlock["source"]["media_type"],
      data: uint8ArrayToBase64(image.data),
    },
  };
}

export async function fetchRemoteImage(
  url: string,
): Promise<RemoteImageData | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return null;

    return {
      mediaType: resp.headers.get("content-type"),
      data: new Uint8Array(await resp.arrayBuffer()),
    };
  } catch {
    return null;
  }
}

function inferMediaTypeFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".webp")) return "image/webp";
  } catch { /* invalid URL */ }
  return null;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Build assistant content blocks in strict order: thinking → text → tool_use */
function buildAssistantBlocks(msg: Message): AnthropicAssistantContentBlock[] {
  const blocks: AnthropicAssistantContentBlock[] = [];

  // 1. thinking / redacted_thinking
  const thinkingBlock = buildThinkingBlock(
    msg.reasoning_text,
    msg.reasoning_opaque,
  );
  if (thinkingBlock) blocks.push(thinkingBlock);

  // 2. text
  if (typeof msg.content === "string" && msg.content) {
    blocks.push({ type: "text", text: msg.content });
  }

  // 3. tool_use
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: safeJsonParse(tc.function.arguments),
      });
    }
  }

  // Ensure at least one block
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }

  return blocks;
}

function buildThinkingBlock(
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
): AnthropicThinkingBlock | AnthropicRedactedThinkingBlock | null {
  if (reasoningText) {
    const block: AnthropicThinkingBlock = {
      type: "thinking",
      thinking: reasoningText,
    };
    if (reasoningOpaque) block.signature = reasoningOpaque;
    return block;
  }
  if (reasoningOpaque) {
    return { type: "redacted_thinking", data: reasoningOpaque };
  }
  return null;
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

function translateTools(tools: Tool[]): AnthropicMessagesPayload["tools"] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function translateToolChoice(
  tc: NonNullable<ChatCompletionsPayload["tool_choice"]>,
): AnthropicMessagesPayload["tool_choice"] {
  if (typeof tc === "string") {
    switch (tc) {
      case "auto":
        return { type: "auto" };
      case "none":
        return { type: "none" };
      case "required":
        return { type: "any" };
      default:
        return undefined;
    }
  }
  if (tc.type === "function" && tc.function?.name) {
    return { type: "tool", name: tc.function.name };
  }
  return undefined;
}
