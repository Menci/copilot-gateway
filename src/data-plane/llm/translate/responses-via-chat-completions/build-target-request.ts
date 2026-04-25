import type { ResponsesPayload } from "../../../../lib/responses-types.ts";
import { translateResponsesToChatCompletions } from "../../../../lib/translate/responses-to-chat-completions.ts";

export const buildTargetRequest = (payload: ResponsesPayload) =>
  translateResponsesToChatCompletions(payload);
