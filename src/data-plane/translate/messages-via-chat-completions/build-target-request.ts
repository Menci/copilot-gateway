import type { AnthropicMessagesPayload } from "../../../lib/anthropic-types.ts";
import { translateToOpenAI } from "../../../lib/translate/openai.ts";

export const buildTargetRequest = (payload: AnthropicMessagesPayload) =>
  translateToOpenAI(payload);
