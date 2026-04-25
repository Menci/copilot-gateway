import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import type { StreamExecuteResult } from "../../../shared/errors/result.ts";

const isContextWindowError = (text: string): boolean =>
  text.includes("Request body is too large for model context window") ||
  text.includes("context_length_exceeded");

/**
 * Copilot reports context-window failures using its own strings (for example
 * `Request body is too large for model context window`), but Messages clients
 * expect a Messages-shaped `invalid_request_error` and Claude Code in
 * particular uses that shape to trigger compaction instead of surfacing a raw
 * upstream error.
 *
 * This workaround is source-owned on `messages/respond.ts`, not target-owned,
 * because the same Messages client contract must hold whether `/v1/messages`
 * was served natively or translated via `/responses` or `/chat/completions`.
 *
 * References:
 * - https://docs.claude.com/en/docs/claude-code/common-workflows#prompt-too-long
 */
export const rewriteContextWindowError = (
  result: StreamExecuteResult<MessagesResponse>,
): StreamExecuteResult<MessagesResponse> => {
  if (result.type !== "upstream-error") return result;

  const body = new TextDecoder().decode(result.body);
  if (!isContextWindowError(body)) return result;

  return {
    type: "upstream-error",
    status: 400,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.",
      },
    })),
  };
};
