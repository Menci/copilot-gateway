// Usage tracking middleware — intercepts responses to extract token usage
// without modifying route handlers

import type { Context, Next } from "hono";
import { recordUsage } from "../lib/usage-tracker.ts";
import { touchApiKeyLastUsed } from "../lib/api-keys.ts";

const PROXY_SUFFIXES = ["/messages", "/chat/completions", "/responses", "/embeddings"];

function isProxyPath(path: string): boolean {
  return PROXY_SUFFIXES.some((s) => path === s || path === `/v1${s}`);
}

export const usageMiddleware = async (c: Context, next: Next) => {
  if (!isProxyPath(c.req.path) || c.req.method !== "POST") {
    return next();
  }

  // Extract model from request body
  let model = "unknown";
  try {
    const cloned = c.req.raw.clone();
    const body = await cloned.json();
    if (typeof body.model === "string") model = body.model;
  } catch { /* ignore parse errors */ }

  await next();

  const keyId: string | undefined = c.get("apiKeyId");
  if (!keyId) return;

  const contentType = c.res.headers.get("content-type") ?? "";
  const status = c.res.status;
  if (status < 200 || status >= 300) return; // skip error responses

  try {
    if (contentType.includes("text/event-stream")) {
      interceptStreaming(c, keyId, model);
    } else {
      await interceptNonStreaming(c, keyId, model);
    }
  } catch (e) {
    console.error("Usage tracking error:", e);
  }
};

async function interceptNonStreaming(c: Context, keyId: string, model: string): Promise<void> {
  const original = c.res;
  const cloned = original.clone();
  // deno-lint-ignore no-explicit-any
  let json: any;
  try { json = await cloned.json(); } catch { return; }

  const usage = extractUsageFromJson(json);
  if (usage) {
    const p1 = recordUsage(keyId, model, usage.input, usage.output).catch((e) =>
      console.error("Usage record error:", e)
    );
    const p2 = touchApiKeyLastUsed(keyId).catch((e) =>
      console.error("Touch lastUsedAt error:", e)
    );
    safeWaitUntil(c, p1);
    safeWaitUntil(c, p2);
  }
}

function interceptStreaming(c: Context, keyId: string, model: string): void {
  const original = c.res;
  const body = original.body;
  if (!body) return;

  let inputTokens = 0;
  let outputTokens = 0;
  let gotInputFromStart = false;
  let buffer = "";

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      // Parse SSE lines to find usage
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          extractUsageFromStreamEvent(parsed, gotInputFromStart, (i, o, fromStart) => {
            inputTokens += i;
            outputTokens += o;
            if (fromStart) gotInputFromStart = true;
          });
        } catch { /* ignore non-JSON lines */ }
      }
    },
    flush() {
      // Process any remaining buffer
      if (buffer.startsWith("data: ")) {
        const data = buffer.slice(6).trim();
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            extractUsageFromStreamEvent(parsed, gotInputFromStart, (i, o, fromStart) => {
              inputTokens += i;
              outputTokens += o;
              if (fromStart) gotInputFromStart = true;
            });
          } catch { /* ignore */ }
        }
      }

      if (inputTokens > 0 || outputTokens > 0) {
        const p1 = recordUsage(keyId, model, inputTokens, outputTokens).catch((e) =>
          console.error("Usage record error:", e)
        );
        const p2 = touchApiKeyLastUsed(keyId).catch((e) =>
          console.error("Touch lastUsedAt error:", e)
        );
        safeWaitUntil(c, p1);
        safeWaitUntil(c, p2);
      }
    },
  });

  const newBody = body.pipeThrough(transform);
  c.res = new Response(newBody, {
    status: original.status,
    headers: original.headers,
  });
}

/** Safely call waitUntil if available (CF Workers). Deno Deploy throws on c.executionCtx access. */
function safeWaitUntil(c: Context, promise: Promise<unknown>): void {
  try {
    c.executionCtx?.waitUntil?.(promise);
  } catch {
    // Deno Deploy: no ExecutionContext — promises settle on their own
  }
}

interface UsageInfo {
  input: number;
  output: number;
}

// deno-lint-ignore no-explicit-any
function extractUsageFromJson(json: any): UsageInfo | null {
  // Anthropic Messages: { usage: { input_tokens, output_tokens } }
  if (json?.usage?.input_tokens != null) {
    return { input: json.usage.input_tokens + (json.usage.cache_read_input_tokens ?? 0) + (json.usage.cache_creation_input_tokens ?? 0), output: json.usage.output_tokens ?? 0 };
  }
  // OpenAI Chat Completions: { usage: { prompt_tokens, completion_tokens } }
  if (json?.usage?.prompt_tokens != null) {
    return { input: json.usage.prompt_tokens, output: json.usage.completion_tokens ?? 0 };
  }
  return null;
}

// deno-lint-ignore no-explicit-any
function extractUsageFromStreamEvent(parsed: any, gotInputFromStart: boolean, add: (input: number, output: number, fromStart: boolean) => void): void {
  // Anthropic message_start: { message: { usage: { input_tokens } } }
  if (parsed.type === "message_start" && parsed.message?.usage) {
    const u = parsed.message.usage;
    const inputFromStart = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (inputFromStart > 0) {
      add(inputFromStart, 0, true);
    }
  }
  // Anthropic message_delta: { usage: { output_tokens, input_tokens? } }
  // In translated streams (OpenAI→Anthropic), the message_start may have
  // input_tokens=0 because the upstream usage-only chunk arrives after the
  // first chunk. The usage-only chunk generates a supplemental message_delta
  // carrying both input_tokens and output_tokens. We only extract input_tokens
  // from message_delta when message_start didn't already provide them.
  if (parsed.type === "message_delta" && parsed.usage?.output_tokens != null) {
    let deltaInput = 0;
    if (!gotInputFromStart && parsed.usage.input_tokens != null) {
      deltaInput = (parsed.usage.input_tokens ?? 0) + (parsed.usage.cache_read_input_tokens ?? 0) + (parsed.usage.cache_creation_input_tokens ?? 0);
    }
    add(deltaInput, parsed.usage.output_tokens, false);
  }
  // Responses response.completed: { response: { usage: { input_tokens, output_tokens } } }
  if (parsed.type === "response.completed" && parsed.response?.usage) {
    const u = parsed.response.usage;
    add(u.input_tokens ?? 0, u.output_tokens ?? 0, false);
  }
  // OpenAI Chat Completions chunk with usage
  if (parsed.usage?.prompt_tokens != null) {
    add(parsed.usage.prompt_tokens, parsed.usage.completion_tokens ?? 0, false);
  }
}
