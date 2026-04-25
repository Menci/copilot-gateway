import type { ChatCompletionsPayload } from "../../../../lib/chat-completions-types.ts";
import { translateChatCompletionsToResponses } from "../../../../lib/translate/chat-completions-to-responses.ts";

export const buildTargetRequest = (payload: ChatCompletionsPayload) =>
  translateChatCompletionsToResponses(payload);
