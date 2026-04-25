import type { ChatCompletionsPayload } from "../../../../lib/chat-completions-types.ts";
import {
  fetchRemoteImage,
  translateChatCompletionsToMessages,
} from "../../../../lib/translate/chat-completions-to-messages.ts";

export const buildTargetRequest = async (
  payload: ChatCompletionsPayload,
) =>
  await translateChatCompletionsToMessages(payload, {
    loadRemoteImage: fetchRemoteImage,
  });
