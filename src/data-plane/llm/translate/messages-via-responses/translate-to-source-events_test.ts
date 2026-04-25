import { assertEquals } from "@std/assert";
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../../lib/responses-types.ts";
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

Deno.test("translateToSourceEvents does not emit mixed frames for created+completed fallback", async () => {
  async function* stream() {
    yield toSseFrame({
      type: "response.created",
      response: makeResponse("in_progress"),
    });
    yield toSseFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    });
  }

  const frames = [];

  for await (const frame of translateToSourceEvents(stream())) {
    frames.push(frame);
  }

  assertEquals(frames.length, 1);
  assertEquals(frames[0]?.type, "json");
});
