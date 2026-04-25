import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SseFrame } from "./types.ts";

export const proxySSE = (
  c: Context,
  events: AsyncIterable<SseFrame>,
): Response =>
  streamSSE(c, async (stream) => {
    for await (const event of events) {
      await stream.writeSSE({
        event: event.event,
        data: event.data,
      });
    }
  });
