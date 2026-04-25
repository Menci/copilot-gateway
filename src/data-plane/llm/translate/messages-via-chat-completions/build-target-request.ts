import type { MessagesPayload } from "../../../../lib/messages-types.ts";
import { translateMessagesToChatCompletions } from "../../../../lib/translate/messages-to-chat-completions.ts";

export const buildTargetRequest = (payload: MessagesPayload) =>
  translateMessagesToChatCompletions(payload);
