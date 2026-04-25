import type {
  MessagesResponse,
  MessagesStreamEventData,
} from "../../../../lib/messages-types.ts";
import type { ResponsesResult } from "../../../../lib/responses-types.ts";
import { translateMessagesToResponsesResult } from "../../../../lib/translate/messages-to-responses.ts";
import {
  createMessagesToResponsesStreamState,
  translateMessagesEventToResponsesEvents,
} from "../../../../lib/translate/messages-to-responses-stream.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../shared/stream/types.ts";

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<StreamFrame<MessagesResponse>>,
  responseId: string,
  model: string,
): AsyncGenerator<StreamFrame<ResponsesResult>> {
  const state = createMessagesToResponsesStreamState(responseId, model);

  for await (const frame of frames) {
    if (frame.type === "json") {
      yield jsonFrame(translateMessagesToResponsesResult(frame.data));
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

    for (
      const translated of translateMessagesEventToResponsesEvents(event, state)
    ) {
      yield sseFrame(JSON.stringify(translated), translated.type);
    }
  }
};
