import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../../../../lib/chat-completions-types.ts";
import type { ResponsesResult } from "../../../../lib/responses-types.ts";
import {
  createChatCompletionsToResponsesStreamState,
  flushChatCompletionsToResponsesEvents,
  translateChatCompletionsChunkToResponsesEvents,
  translateChatCompletionToResponsesResult,
} from "../../../../lib/translate/chat-completions-to-responses.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../shared/stream/types.ts";

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<StreamFrame<ChatCompletionResponse>>,
): AsyncGenerator<StreamFrame<ResponsesResult>> {
  const state = createChatCompletionsToResponsesStreamState();

  for await (const frame of frames) {
    if (frame.type === "json") {
      yield jsonFrame(translateChatCompletionToResponsesResult(frame.data));
      continue;
    }

    const data = frame.data.trim();
    if (!data || data === "[DONE]") continue;

    let chunk: ChatCompletionChunk;

    try {
      chunk = JSON.parse(data) as ChatCompletionChunk;
    } catch {
      continue;
    }

    for (
      const event of translateChatCompletionsChunkToResponsesEvents(
        chunk,
        state,
      )
    ) {
      yield sseFrame(JSON.stringify(event), event.type);
    }
  }

  for (const event of flushChatCompletionsToResponsesEvents(state)) {
    yield sseFrame(JSON.stringify(event), event.type);
  }
};
