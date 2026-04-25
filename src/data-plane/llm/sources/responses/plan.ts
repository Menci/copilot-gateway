import type { ResponsesPayload } from "../../../../lib/responses-types.ts";
import { getModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import type { ResponsesPlan } from "../../shared/types/plan.ts";

const hasVision = (payload: ResponsesPayload): boolean => {
  if (!Array.isArray(payload.input)) return false;

  return payload.input.some((item) =>
    item.type === "message" &&
    Array.isArray(item.content) &&
    item.content.some((block) =>
      (block as { type?: string }).type === "input_image" ||
      (block as { type?: string }).type === "image"
    )
  );
};

const getInitiator = (payload: ResponsesPayload): "user" | "agent" => {
  if (!Array.isArray(payload.input)) return "user";

  const lastItem = payload.input[payload.input.length - 1];
  return lastItem?.type === "function_call_output" ? "agent" : "user";
};

export const planResponsesRequest = async (
  payload: ResponsesPayload,
  githubToken: string,
  accountType: string,
): Promise<ResponsesPlan | null> => {
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

  if (capabilities.supportsResponses) {
    return {
      source: "responses",
      target: "responses",
      wantsStream,
      fetchOptions,
    };
  }

  if (capabilities.supportsMessages) {
    return {
      source: "responses",
      target: "messages",
      wantsStream,
      fetchOptions,
    };
  }

  if (capabilities.supportsChatCompletions) {
    return {
      source: "responses",
      target: "chat-completions",
      wantsStream,
      fetchOptions,
    };
  }

  return null;
};
