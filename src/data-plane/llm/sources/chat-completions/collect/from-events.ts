import type { ChatCompletionResponse } from "../../../../../lib/chat-completions-types.ts";
import { reassembleChatCompletionsSSE } from "../../../../../lib/sse-reassemble.ts";
import {
  collectSSE,
  sseFramesToStream,
} from "../../../shared/stream/collect-sse.ts";
import {
  type SseFrame,
  sseFrame,
  type StreamFrame,
} from "../../../shared/stream/types.ts";

const makeChunk = (
  response: ChatCompletionResponse,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) => ({
  id: response.id,
  object: "chat.completion.chunk",
  created: response.created,
  model: response.model,
  choices: [{
    index: 0,
    delta,
    finish_reason: finishReason,
  }],
});

export const chatCompletionToSSEFrames = (
  response: ChatCompletionResponse,
): SseFrame[] => {
  const choice = response.choices[0];
  const frames: SseFrame[] = [
    sseFrame(JSON.stringify(makeChunk(response, { role: "assistant" }))),
  ];

  if (
    choice?.message.reasoning_text !== undefined &&
    choice.message.reasoning_text !== null
  ) {
    frames.push(
      sseFrame(JSON.stringify(makeChunk(response, {
        reasoning_text: choice.message.reasoning_text,
      }))),
    );
  }

  if (
    choice?.message.reasoning_opaque !== undefined &&
    choice.message.reasoning_opaque !== null
  ) {
    frames.push(
      sseFrame(JSON.stringify(makeChunk(response, {
        reasoning_opaque: choice.message.reasoning_opaque,
      }))),
    );
  }

  if (
    choice?.message.content !== undefined && choice.message.content !== null
  ) {
    frames.push(
      sseFrame(JSON.stringify(makeChunk(response, {
        content: choice.message.content,
      }))),
    );
  }

  choice?.message.tool_calls?.forEach((toolCall, index) => {
    frames.push(
      sseFrame(JSON.stringify(makeChunk(response, {
        tool_calls: [{
          index,
          id: toolCall.id,
          type: toolCall.type,
          function: toolCall.function,
        }],
      }))),
    );
  });

  frames.push(
    sseFrame(
      JSON.stringify(makeChunk(response, {}, choice?.finish_reason ?? null)),
    ),
  );

  if (response.usage) {
    frames.push(
      sseFrame(JSON.stringify({
        id: response.id,
        object: "chat.completion.chunk",
        created: response.created,
        model: response.model,
        choices: [],
        usage: response.usage,
      })),
    );
  }

  frames.push(sseFrame("[DONE]"));
  return frames;
};

export const expandChatFrames = async function* (
  frames: AsyncIterable<StreamFrame<ChatCompletionResponse>>,
): AsyncGenerator<SseFrame> {
  for await (const frame of frames) {
    if (frame.type === "sse") {
      yield frame;
      continue;
    }

    yield* chatCompletionToSSEFrames(frame.data);
  }
};

export const collectChatEventsToCompletion = async (
  frames: AsyncIterable<StreamFrame<ChatCompletionResponse>>,
): Promise<ChatCompletionResponse> => {
  const collected = await collectSSE(expandChatFrames(frames));
  return await reassembleChatCompletionsSSE(sseFramesToStream(collected));
};
