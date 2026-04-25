import type { ChatCompletionsPayload } from "../../../../../lib/chat-completions-types.ts";
import { normalizeModelName } from "../../../../../lib/model-name.ts";

export const normalizeChatRequest = (
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload => {
  if (typeof payload.model === "string") {
    payload.model = normalizeModelName(payload.model);
  }
  return payload;
};
