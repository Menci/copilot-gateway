import type { AnthropicResponse } from "./anthropic-types.ts";

export function mapStopReason(
  reason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (reason === null) return null;
  const map = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "refusal",
  } as const;
  return map[reason];
}
