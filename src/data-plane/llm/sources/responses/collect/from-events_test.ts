import { assertEquals, assertFalse } from "@std/assert";
import type { ResponsesResult } from "../../../../../lib/responses-types.ts";
import { responsesResultToSSEFrames } from "./from-events.ts";

const completedResponse: ResponsesResult = {
  id: "resp_completed",
  object: "response",
  model: "gpt-test",
  status: "completed",
  output_text: "Hello",
  output: [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Hello" }],
  }],
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
};

Deno.test("responsesResultToSSEFrames starts JSON fallback streams with an empty in-progress snapshot", () => {
  const frames = responsesResultToSSEFrames(completedResponse);

  const created = JSON.parse(frames[0].data) as {
    type: string;
    response: Record<string, unknown>;
  };
  const inProgress = JSON.parse(frames[1].data) as {
    type: string;
    response: Record<string, unknown>;
  };
  const completed = JSON.parse(frames[frames.length - 1].data) as {
    type: string;
    response: Record<string, unknown>;
  };

  assertEquals(created.type, "response.created");
  assertEquals(created.response.status, "in_progress");
  assertEquals(created.response.output, []);
  assertEquals(created.response.output_text, "");
  assertFalse("error" in created.response);
  assertFalse("incomplete_details" in created.response);

  assertEquals(inProgress.type, "response.in_progress");
  assertEquals(inProgress.response.output, []);
  assertEquals(inProgress.response.output_text, "");

  assertEquals(completed.type, "response.completed");
  assertEquals(completed.response.output_text, "Hello");
});

Deno.test("responsesResultToSSEFrames keeps incomplete details only on the terminal event", () => {
  const frames = responsesResultToSSEFrames({
    ...completedResponse,
    id: "resp_incomplete",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  });

  const created = JSON.parse(frames[0].data) as {
    response: Record<string, unknown>;
  };
  const terminal = JSON.parse(frames[frames.length - 1].data) as {
    type: string;
    response: Record<string, unknown>;
  };

  assertFalse("incomplete_details" in created.response);
  assertEquals(terminal.type, "response.incomplete");
  assertEquals(
    (terminal.response.incomplete_details as Record<string, unknown>).reason,
    "max_output_tokens",
  );
});

Deno.test("responsesResultToSSEFrames keeps failure details only on the terminal event", () => {
  const frames = responsesResultToSSEFrames({
    id: "resp_failed",
    object: "response",
    model: "gpt-test",
    status: "failed",
    output_text: "",
    output: [],
    error: {
      message: "upstream failed",
      type: "server_error",
      code: "boom",
    },
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
  });

  const created = JSON.parse(frames[0].data) as {
    response: Record<string, unknown>;
  };
  const terminal = JSON.parse(frames[frames.length - 1].data) as {
    type: string;
    response: Record<string, unknown>;
  };

  assertFalse("error" in created.response);
  assertEquals(terminal.type, "response.failed");
  assertEquals(
    (terminal.response.error as Record<string, unknown>).message,
    "upstream failed",
  );
});
