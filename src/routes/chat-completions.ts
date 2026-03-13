// POST /v1/chat/completions — passthrough to Copilot

import type { Context } from "hono";
import { copilotFetch } from "../lib/copilot.ts";
import { getGithubCredentials } from "../lib/github.ts";

/** Detect if request body contains image content */
function hasVision(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return msg.content.some(
      (part: { type?: string }) => part.type === "image_url",
    );
  });
}

function isClaude(model: string): boolean {
  return model.startsWith("claude");
}

// deno-lint-ignore no-explicit-any
type ChatChoice = Record<string, any>;
// deno-lint-ignore no-explicit-any
type ChatResponse = Record<string, any>;

/**
 * XXX: Copilot upstream bug — when converting Anthropic multi-block responses
 * (text + tool_use) to Chat Completions format, it creates one choice per
 * content block instead of merging them into a single choice.
 * We merge them back: concatenate content strings, collect tool_calls.
 */
function mergeChoices(data: ChatResponse): ChatResponse {
  const choices = data.choices as ChatChoice[] | undefined;
  if (!Array.isArray(choices) || choices.length <= 1) return data;

  const merged: ChatChoice = { ...choices[0], index: 0 };
  const msg = { ...merged.message };
  let content = msg.content ?? "";
  // deno-lint-ignore no-explicit-any
  const toolCalls: any[] = msg.tool_calls ? [...msg.tool_calls] : [];
  let finishReason = merged.finish_reason;

  for (let i = 1; i < choices.length; i++) {
    const c = choices[i];
    if (c.message?.content) {
      content += c.message.content;
    }
    if (c.message?.tool_calls) {
      toolCalls.push(...c.message.tool_calls);
    }
    if (c.finish_reason) finishReason = c.finish_reason;
  }

  msg.content = content || null;
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  merged.message = msg;
  merged.finish_reason = finishReason;

  return { ...data, choices: [merged] };
}

/**
 * Fix streaming chunks: remap all choice indices to 0 so split choices
 * are treated as a single response by the client.
 */
function fixStreamLine(line: string): string {
  if (!line.startsWith("data: ") || line === "data: [DONE]") return line;
  try {
    const data = JSON.parse(line.slice(6)) as ChatResponse;
    const choices = data.choices as ChatChoice[] | undefined;
    if (Array.isArray(choices)) {
      for (const c of choices) c.index = 0;
      return "data: " + JSON.stringify(data);
    }
  } catch { /* pass through unparseable lines */ }
  return line;
}

function fixStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete last line
      for (const line of lines) {
        controller.enqueue(encoder.encode(fixStreamLine(line) + "\n"));
      }
    },
    flush(controller) {
      if (buffer) {
        controller.enqueue(encoder.encode(fixStreamLine(buffer) + "\n"));
      }
    },
  }));
}

export const chatCompletions = async (c: Context) => {
  try {
    const body = await c.req.json();
    const vision = hasVision(body);
    const needsFix = isClaude(body.model ?? "");
    const { token: githubToken, accountType } = await getGithubCredentials();

    const resp = await copilotFetch(
      "/chat/completions",
      { method: "POST", body: JSON.stringify(body) },
      githubToken,
      accountType,
      { vision },
    );

    const contentType =
      resp.headers.get("content-type") ?? "application/json";

    if (contentType.includes("text/event-stream")) {
      const stream = needsFix && resp.body ? fixStream(resp.body) : resp.body;
      return new Response(stream, {
        status: resp.status,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }

    if (needsFix && resp.status >= 200 && resp.status < 300) {
      const data = await resp.json() as ChatResponse;
      return c.json(mergeChoices(data), resp.status as 200);
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: { message: msg, type: "api_error" } }, 502);
  }
};
