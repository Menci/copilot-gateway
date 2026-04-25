export interface SseFrame {
  type: "sse";
  event?: string;
  data: string;
}

export interface JsonFrame<T> {
  type: "json";
  data: T;
}

export type StreamFrame<T> = SseFrame | JsonFrame<T>;

export const sseFrame = (data: string, event?: string): SseFrame => ({
  type: "sse",
  event,
  data,
});

export const jsonFrame = <T>(data: T): JsonFrame<T> => ({
  type: "json",
  data,
});
