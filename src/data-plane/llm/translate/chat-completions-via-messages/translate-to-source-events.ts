import type {
  MessagesResponse,
  MessagesStreamEventData,
} from "../../../../lib/messages-types.ts";
import type { ChatCompletionResponse } from "../../../../lib/chat-completions-types.ts";
import { translateMessagesToChatCompletionsResponse } from "../../../../lib/translate/messages-to-chat-completions.ts";
import {
  createMessagesToChatCompletionsStreamState,
  translateMessagesEventToChatCompletionsChunks,
} from "../../../../lib/translate/messages-to-chat-completions-stream.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../shared/stream/types.ts";

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<StreamFrame<MessagesResponse>>,
): AsyncGenerator<StreamFrame<ChatCompletionResponse>> {
  const state = createMessagesToChatCompletionsStreamState();

  for await (const frame of frames) {
    if (frame.type === "json") {
      yield jsonFrame(translateMessagesToChatCompletionsResponse(frame.data));
      continue;
    }

    const data = frame.data.trim();
    if (!data || data === "[DONE]") continue;

    let event: MessagesStreamEventData;

    try {
      event = JSON.parse(data) as MessagesStreamEventData;
    } catch {
      continue;
    }

    const translated = translateMessagesEventToChatCompletionsChunks(
      event,
      state,
    );

    if (translated === "DONE") {
      yield sseFrame("[DONE]");
      continue;
    }

    for (const chunk of translated) {
      yield sseFrame(JSON.stringify(chunk));
    }
  }
};
