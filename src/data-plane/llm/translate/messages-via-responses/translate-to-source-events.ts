import type { MessagesResponse } from "../../../../lib/messages-types.ts";
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../../lib/responses-types.ts";
import { translateResponsesToMessagesResponse } from "../../../../lib/translate/responses-to-messages.ts";
import {
  createResponsesToMessagesStreamState,
  translateResponsesStreamEventToMessagesEvents,
} from "../../../../lib/translate/responses-to-messages-stream.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../shared/stream/types.ts";

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<StreamFrame<ResponsesResult>>,
): AsyncGenerator<StreamFrame<MessagesResponse>> {
  const state = createResponsesToMessagesStreamState();
  let sawStructuredOutput = false;
  let streamingCommitted = false;
  const pendingFrames: Array<ReturnType<typeof sseFrame>> = [];

  for await (const frame of frames) {
    if (frame.type === "json") {
      if (!streamingCommitted) pendingFrames.length = 0;
      yield jsonFrame(translateResponsesToMessagesResponse(frame.data));
      continue;
    }

    const data = frame.data.trim();
    if (!data) continue;

    let event: ResponseStreamEvent;

    try {
      event = JSON.parse(data) as ResponseStreamEvent;
    } catch {
      continue;
    }

    if (frame.event && !(event as { type?: string }).type) {
      event = { ...event, type: frame.event } as ResponseStreamEvent;
    }

    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done" ||
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.reasoning_summary_text.done" ||
      event.type === "response.output_text.delta" ||
      event.type === "response.output_text.done" ||
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.function_call_arguments.done"
    ) {
      sawStructuredOutput = true;
      if (!streamingCommitted) {
        streamingCommitted = true;
        for (const pending of pendingFrames) yield pending;
        pendingFrames.length = 0;
      }
    }

    if (
      !streamingCommitted &&
      !sawStructuredOutput &&
      (event.type === "response.completed" ||
        event.type === "response.incomplete")
    ) {
      pendingFrames.length = 0;
      yield jsonFrame(
        translateResponsesToMessagesResponse(event.response as ResponsesResult),
      );
      continue;
    }

    for (
      const translated of translateResponsesStreamEventToMessagesEvents(
        event,
        state,
      )
    ) {
      const translatedFrame = sseFrame(
        JSON.stringify(translated),
        translated.type,
      );
      if (streamingCommitted) {
        yield translatedFrame;
      } else {
        pendingFrames.push(translatedFrame);
      }
    }
  }

  if (!streamingCommitted) {
    for (const pending of pendingFrames) yield pending;
  }
};
