export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          yield { event: currentEvent, data: line.slice(6) };
          currentEvent = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Stream SSE events from an upstream response body, applying an optional transform.
 * If no transform is provided, events are forwarded as-is.
 */
export function proxySSE(
  c: Context,
  body: ReadableStream<Uint8Array>,
  transform?: (event: string, data: string) => SSEEvent[] | null,
  label = "SSE proxy",
): Response {
  return streamSSE(c, async (stream) => {
    try {
      for await (const { event, data } of parseSSEStream(body)) {
        if (transform) {
          const results = transform(event, data);
          if (results) {
            for (const e of results) {
              await stream.writeSSE({ event: e.event, data: e.data });
            }
          }
        } else {
          await stream.writeSSE({ event: event || undefined, data });
        }
      }
    } catch (e) {
      console.error(`${label} stream error:`, e);
    }
  });
}
