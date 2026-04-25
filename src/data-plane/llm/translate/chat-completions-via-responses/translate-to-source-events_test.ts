import { assertEquals } from "@std/assert";
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../../lib/responses-types.ts";
import { expandChatFrames } from "../../sources/chat-completions/collect/from-events.ts";
import { sseFrame, type StreamFrame } from "../../shared/stream/types.ts";
import { translateToSourceEvents } from "./translate-to-source-events.ts";

const makeResponse = (status: ResponsesResult["status"]): ResponsesResult => ({
  id: "resp_123",
  object: "response",
  model: "gpt-test",
  status,
  output_text: "hello",
  output: [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "hello" }],
  }],
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  },
});

const toSseFrame = (
  event: ResponseStreamEvent,
): StreamFrame<ResponsesResult> => sseFrame(JSON.stringify(event), event.type);

const countDoneSentinels = async (
  frames: StreamFrame<ResponsesResult>[],
): Promise<number> => {
  let doneCount = 0;

  async function* stream() {
    yield* frames;
  }

  for await (
    const frame of expandChatFrames(translateToSourceEvents(stream()))
  ) {
    if (frame.data === "[DONE]") doneCount++;
  }

  return doneCount;
};

const countAssistantStartChunksAndDone = async (
  frames: StreamFrame<ResponsesResult>[],
): Promise<{ assistantStartCount: number; doneCount: number }> => {
  let assistantStartCount = 0;
  let doneCount = 0;

  async function* stream() {
    yield* frames;
  }

  for await (
    const frame of expandChatFrames(translateToSourceEvents(stream()))
  ) {
    if (frame.data === "[DONE]") {
      doneCount++;
      continue;
    }

    const parsed = JSON.parse(frame.data) as {
      choices?: Array<{ delta?: { role?: string } }>;
    };
    if (parsed.choices?.[0]?.delta?.role === "assistant") assistantStartCount++;
  }

  return { assistantStartCount, doneCount };
};

Deno.test("translateToSourceEvents emits exactly one [DONE] for structured responses stream", async () => {
  const doneCount = await countDoneSentinels([
    toSseFrame({
      type: "response.created",
      response: makeResponse("in_progress"),
    }),
    toSseFrame({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "hello",
    }),
    toSseFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    }),
  ]);

  assertEquals(doneCount, 1);
});

Deno.test("translateToSourceEvents emits exactly one [DONE] for fallback completion stream", async () => {
  const doneCount = await countDoneSentinels([
    toSseFrame({
      type: "response.output_text.done",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text: "hello",
    }),
    toSseFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    }),
  ]);

  assertEquals(doneCount, 1);
});

Deno.test("translateToSourceEvents avoids assistant-start duplication for created+completed fallback", async () => {
  const { assistantStartCount, doneCount } =
    await countAssistantStartChunksAndDone([
      toSseFrame({
        type: "response.created",
        response: makeResponse("in_progress"),
      }),
      toSseFrame({
        type: "response.completed",
        response: makeResponse("completed"),
      }),
    ]);

  assertEquals(assistantStartCount, 1);
  assertEquals(doneCount, 1);
});
