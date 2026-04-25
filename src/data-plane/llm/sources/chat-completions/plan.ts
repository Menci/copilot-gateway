import type { ChatCompletionsPayload } from "../../../../lib/chat-completions-types.ts";
import { getModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import type { ChatPlan } from "../../shared/types/plan.ts";

const hasVision = (payload: ChatCompletionsPayload): boolean =>
  payload.messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url")
  );

export const planChatRequest = async (
  payload: ChatCompletionsPayload,
  githubToken: string,
  accountType: string,
): Promise<ChatPlan> => {
  const capabilities = await getModelCapabilities(
    payload.model,
    githubToken,
    accountType,
  );
  const wantsStream = payload.stream === true;
  const fetchOptions = { vision: hasVision(payload) };

  if (capabilities.supportsMessages) {
    return {
      source: "chat-completions",
      target: "messages",
      wantsStream,
      fetchOptions,
    };
  }

  if (capabilities.supportsChatCompletions) {
    return {
      source: "chat-completions",
      target: "chat-completions",
      wantsStream,
      fetchOptions,
    };
  }

  if (capabilities.supportsResponses) {
    return {
      source: "chat-completions",
      target: "responses",
      wantsStream,
      fetchOptions,
    };
  }

  return payload.model.startsWith("claude")
    ? {
      source: "chat-completions",
      target: "messages",
      wantsStream,
      fetchOptions,
    }
    : {
      source: "chat-completions",
      target: "chat-completions",
      wantsStream,
      fetchOptions,
    };
};
