import type { SseFrame } from "./types.ts";

export const collectSSE = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
};

export const encodeSSEFrames = (frames: Iterable<SseFrame>): string =>
  Array.from(frames).map((frame) => {
    const lines = frame.event
      ? [`event: ${frame.event}`, `data: ${frame.data}`]
      : [`data: ${frame.data}`];

    return `${lines.join("\n")}\n\n`;
  }).join("");

export const sseFramesToStream = (
  frames: Iterable<SseFrame>,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const text = encodeSSEFrames(frames);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
};
