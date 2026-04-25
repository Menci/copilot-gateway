import type { MessagesResponse } from "../../../../lib/messages-types.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../../../../lib/chat-completions-types.ts";
import {
  createChatCompletionsToMessagesStreamState,
  translateChatCompletionsChunkToMessagesEvents,
} from "../../../../lib/translate/chat-completions-to-messages-stream.ts";
import { translateChatCompletionsToMessagesResponse } from "../../../../lib/translate/chat-completions-to-messages.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../shared/stream/types.ts";

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<StreamFrame<ChatCompletionResponse>>,
): AsyncGenerator<StreamFrame<MessagesResponse>> {
  const state = createChatCompletionsToMessagesStreamState();

  for await (const frame of frames) {
    if (frame.type === "json") {
      yield jsonFrame(translateChatCompletionsToMessagesResponse(frame.data));
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
      const event of translateChatCompletionsChunkToMessagesEvents(
        chunk,
        state,
      )
    ) {
      yield sseFrame(JSON.stringify(event), event.type);
    }
  }
};
