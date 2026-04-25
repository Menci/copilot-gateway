import type { ChatCompletionResponse } from "../../../../lib/chat-completions-types.ts";
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../../lib/responses-types.ts";
import {
  createResponsesToChatCompletionsStreamState,
  translateResponsesEventToChatCompletionsChunks,
  translateResponsesToChatCompletion,
} from "../../../../lib/translate/responses-to-chat-completions.ts";
import {
  jsonFrame,
  sseFrame,
  type StreamFrame,
} from "../../shared/stream/types.ts";

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<StreamFrame<ResponsesResult>>,
): AsyncGenerator<StreamFrame<ChatCompletionResponse>> {
  const state = createResponsesToChatCompletionsStreamState();
  let sawStructuredOutput = false;
  let streamingCommitted = false;
  const pendingFrames: Array<ReturnType<typeof sseFrame>> = [];
  let yieldedJsonFrame = false;
  let yieldedDone = false;

  for await (const frame of frames) {
    if (frame.type === "json") {
      if (!streamingCommitted) pendingFrames.length = 0;
      yieldedJsonFrame = true;
      yield jsonFrame(translateResponsesToChatCompletion(frame.data));
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
      event.type === "response.output_text.delta" ||
      event.type === "response.function_call_arguments.delta"
    ) {
      sawStructuredOutput = true;
      if (!streamingCommitted) {
        streamingCommitted = true;
        for (const pending of pendingFrames) {
          if (pending.data === "[DONE]") yieldedDone = true;
          yield pending;
        }
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
      yieldedJsonFrame = true;
      yield jsonFrame(
        translateResponsesToChatCompletion(event.response as ResponsesResult),
      );
      continue;
    }

    const translated = translateResponsesEventToChatCompletionsChunks(
      event,
      state,
    );

    if (translated === "DONE") {
      const doneFrame = sseFrame("[DONE]");
      if (streamingCommitted) {
        yieldedDone = true;
        yield doneFrame;
      } else {
        pendingFrames.push(doneFrame);
      }
      continue;
    }

    for (const chunk of translated) {
      const chunkFrame = sseFrame(JSON.stringify(chunk));
      if (streamingCommitted) {
        yield chunkFrame;
      } else {
        pendingFrames.push(chunkFrame);
      }
    }
  }

  if (!streamingCommitted && pendingFrames.length > 0) {
    for (const pending of pendingFrames) {
      if (pending.data === "[DONE]") yieldedDone = true;
      yield pending;
    }
  }

  if (
    !yieldedJsonFrame && !yieldedDone && (sawStructuredOutput || !state.done)
  ) {
    yield sseFrame("[DONE]");
  }
};
