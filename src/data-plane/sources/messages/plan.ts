import type { AnthropicMessagesPayload } from "../../../lib/anthropic-types.ts";
import { getAnthropicRequestedReasoningEffort } from "../../../lib/reasoning.ts";
import { getModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import { probeResponsesReasoningEffortForMessages } from "../../shared/probes/probe-responses-reasoning-effort.ts";
import type { MessagesPlan } from "../../shared/types/plan.ts";

const hasVision = (payload: AnthropicMessagesPayload): boolean =>
  payload.messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "image")
  );

const getInitiator = (payload: AnthropicMessagesPayload): "user" | "agent" => {
  const lastMessage = payload.messages[payload.messages.length - 1];
  if (!lastMessage || lastMessage.role !== "user") return "agent";
  if (!Array.isArray(lastMessage.content)) return "user";

  return lastMessage.content.some((block) => block.type !== "tool_result")
    ? "user"
    : "agent";
};

export const planMessagesRequest = async (
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
  rawBeta: string | undefined,
): Promise<MessagesPlan> => {
  const capabilities = await getModelCapabilities(
    payload.model,
    githubToken,
    accountType,
  );
  const wantsStream = payload.stream === true;
  const fetchOptions = {
    vision: hasVision(payload),
    initiator: getInitiator(payload),
  };

  if (capabilities.supportsMessages) {
    return {
      source: "messages",
      target: "messages",
      wantsStream,
      fetchOptions,
      rawBeta,
    };
  }

  const requestedReasoningEffort = getAnthropicRequestedReasoningEffort(
    payload,
  );

  if (capabilities.supportsResponses && requestedReasoningEffort) {
    return {
      source: "messages",
      target: "responses",
      wantsStream,
      fetchOptions,
      reasoningEffort: await probeResponsesReasoningEffort(
        payload,
        githubToken,
        accountType,
      ),
    };
  }

  if (capabilities.supportsResponses && !capabilities.supportsChatCompletions) {
    return {
      source: "messages",
      target: "responses",
      wantsStream,
      fetchOptions,
      reasoningEffort: await probeResponsesReasoningEffort(
        payload,
        githubToken,
        accountType,
      ),
    };
  }

  return {
    source: "messages",
    target: "chat-completions",
    wantsStream,
    fetchOptions,
  };
};

const probeResponsesReasoningEffort = async (
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
) => {
  try {
    return await probeResponsesReasoningEffortForMessages(
      payload,
      githubToken,
      accountType,
    );
  } catch (error) {
    console.warn("Failed to probe Responses reasoning efforts:", error);
    return null;
  }
};
