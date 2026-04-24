import type {
  MessagesResponse,
  MessagesTextCitation,
} from "../../../../lib/messages-types.ts";
import { reassembleMessagesSSE } from "../../../../lib/sse-reassemble.ts";
import {
  collectSSE,
  sseFramesToStream,
} from "../../../shared/stream/collect-sse.ts";
import {
  type SseFrame,
  sseFrame,
  type StreamFrame,
} from "../../../shared/stream/types.ts";

const citationToSsePayload = (citation: MessagesTextCitation) =>
  citation.type === "search_result_location"
    ? {
      type: citation.type,
      source: citation.url,
      title: citation.title,
      search_result_index: citation.search_result_index,
      start_block_index: citation.start_block_index,
      end_block_index: citation.end_block_index,
      ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
    }
    : {
      type: citation.type,
      url: citation.url,
      title: citation.title,
      encrypted_index: citation.encrypted_index,
      ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
    };

export const messagesResponseToSSEFrames = (
  response: MessagesResponse,
): SseFrame[] => {
  const frames: SseFrame[] = [
    sseFrame(
      JSON.stringify({
        type: "message_start",
        message: {
          id: response.id,
          type: response.type,
          role: response.role,
          content: [],
          model: response.model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            ...response.usage,
            output_tokens: 0,
          },
        },
      }),
      "message_start",
    ),
  ];

  response.content.forEach((block, index) => {
    if (block.type === "text") {
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_start",
            index,
            content_block: {
              type: "text",
              text: "",
              ...(block.citations?.length ? { citations: [] } : {}),
            },
          }),
          "content_block_start",
        ),
      );

      for (const citation of block.citations ?? []) {
        frames.push(
          sseFrame(
            JSON.stringify({
              type: "content_block_delta",
              index,
              delta: {
                type: "citations_delta",
                citation: citationToSsePayload(citation),
              },
            }),
            "content_block_delta",
          ),
        );
      }

      if (block.text.length > 0) {
        frames.push(
          sseFrame(
            JSON.stringify({
              type: "content_block_delta",
              index,
              delta: {
                type: "text_delta",
                text: block.text,
              },
            }),
            "content_block_delta",
          ),
        );
      }

      frames.push(
        sseFrame(
          JSON.stringify({ type: "content_block_stop", index }),
          "content_block_stop",
        ),
      );
      return;
    }

    if (block.type === "tool_use") {
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            },
          }),
          "content_block_start",
        ),
      );
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          }),
          "content_block_delta",
        ),
      );
      frames.push(
        sseFrame(
          JSON.stringify({ type: "content_block_stop", index }),
          "content_block_stop",
        ),
      );
      return;
    }

    if (block.type === "server_tool_use") {
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_start",
            index,
            content_block: {
              type: "server_tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            },
          }),
          "content_block_start",
        ),
      );
      frames.push(
        sseFrame(
          JSON.stringify({ type: "content_block_stop", index }),
          "content_block_stop",
        ),
      );
      return;
    }

    if (block.type === "web_search_tool_result") {
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_start",
            index,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: block.tool_use_id,
              content: block.content,
            },
          }),
          "content_block_start",
        ),
      );
      frames.push(
        sseFrame(
          JSON.stringify({ type: "content_block_stop", index }),
          "content_block_stop",
        ),
      );
      return;
    }

    if (block.type === "thinking") {
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "" },
          }),
          "content_block_start",
        ),
      );

      if (block.thinking.length > 0) {
        frames.push(
          sseFrame(
            JSON.stringify({
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: block.thinking },
            }),
            "content_block_delta",
          ),
        );
      }

      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_delta",
            index,
            delta: {
              type: "signature_delta",
              signature: block.signature || "",
            },
          }),
          "content_block_delta",
        ),
      );
      frames.push(
        sseFrame(
          JSON.stringify({ type: "content_block_stop", index }),
          "content_block_stop",
        ),
      );
      return;
    }

    frames.push(
      sseFrame(
        JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "redacted_thinking", data: block.data },
        }),
        "content_block_start",
      ),
    );
    frames.push(
      sseFrame(
        JSON.stringify({ type: "content_block_stop", index }),
        "content_block_stop",
      ),
    );
  });

  frames.push(
    sseFrame(
      JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: response.stop_reason,
          stop_sequence: response.stop_sequence,
        },
        usage: {
          output_tokens: response.usage.output_tokens,
          ...(response.usage.cache_creation_input_tokens !== undefined
            ? {
              cache_creation_input_tokens:
                response.usage.cache_creation_input_tokens,
            }
            : {}),
          ...(response.usage.cache_read_input_tokens !== undefined
            ? {
              cache_read_input_tokens: response.usage.cache_read_input_tokens,
            }
            : {}),
          ...(response.usage.server_tool_use !== undefined
            ? {
              server_tool_use: response.usage.server_tool_use,
            }
            : {}),
        },
      }),
      "message_delta",
    ),
    sseFrame(JSON.stringify({ type: "message_stop" }), "message_stop"),
  );

  return frames;
};

export const expandMessagesFrames = async function* (
  frames: AsyncIterable<StreamFrame<MessagesResponse>>,
): AsyncGenerator<SseFrame> {
  for await (const frame of frames) {
    if (frame.type === "sse") {
      yield frame;
      continue;
    }

    yield* messagesResponseToSSEFrames(frame.data);
  }
};

export const collectMessagesEventsToResponse = async (
  frames: AsyncIterable<StreamFrame<MessagesResponse>>,
): Promise<MessagesResponse> => {
  const collected = await collectSSE(expandMessagesFrames(frames));
  return await reassembleMessagesSSE(sseFramesToStream(collected));
};

export const anthropicResponseToSSEFrames = messagesResponseToSSEFrames;
export const expandAnthropicFrames = expandMessagesFrames;
export const collectAnthropicEventsToResponse = collectMessagesEventsToResponse;
