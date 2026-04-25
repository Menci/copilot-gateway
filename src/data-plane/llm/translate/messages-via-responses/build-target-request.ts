import type { MessagesPayload } from "../../../../lib/messages-types.ts";
import { translateMessagesToResponses } from "../../../../lib/translate/messages-to-responses.ts";

export const buildTargetRequest = (payload: MessagesPayload) =>
  translateMessagesToResponses(payload);
