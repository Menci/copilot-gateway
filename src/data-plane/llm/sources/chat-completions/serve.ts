import type { Context } from "hono";
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../../lib/chat-completions-types.ts";
import { getGithubCredentials } from "../../../../lib/github.ts";
import { normalizeChatRequest } from "./normalize/request.ts";
import { planChatRequest } from "./plan.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../../translate/chat-completions-via-messages/build-target-request.ts";
import { buildTargetRequest as buildResponsesTargetRequest } from "../../translate/chat-completions-via-responses/build-target-request.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { translateToSourceEvents as translateMessagesToSourceEvents } from "../../translate/chat-completions-via-messages/translate-to-source-events.ts";
import { translateToSourceEvents as translateResponsesToSourceEvents } from "../../translate/chat-completions-via-responses/translate-to-source-events.ts";
import { respondChatCompletions } from "./respond.ts";
import {
  internalErrorResult,
  type StreamExecuteResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import type { StreamFrame } from "../../shared/stream/types.ts";

const withTranslatedEvents = <T>(
  result: StreamExecuteResult<T>,
  translate: (
    events: AsyncIterable<StreamFrame<T>>,
  ) => AsyncIterable<StreamFrame<ChatCompletionResponse>>,
): StreamExecuteResult<ChatCompletionResponse> =>
  result.type === "events"
    ? { type: "events", events: translate(result.events) }
    : result;

export const serveChatCompletions = async (
  c: Context,
): Promise<Response> => {
  try {
    const payload = await c.req.json<ChatCompletionsPayload>();
    normalizeChatRequest(payload);
    c.set("model", payload.model || "unknown");

    const { token: githubToken, accountType } = await getGithubCredentials();
    const plan = await planChatRequest(payload, githubToken, accountType);

    if (plan.target === "messages") {
      const result = await emitToMessages({
        sourceApi: "chat-completions",
        payload: await buildMessagesTargetRequest(payload),
        githubToken,
        accountType,
        fetchOptions: plan.fetchOptions,
      });

      return await respondChatCompletions(
        c,
        withTranslatedEvents(result, translateMessagesToSourceEvents),
        plan.wantsStream,
      );
    }

    if (plan.target === "responses") {
      const result = await emitToResponses({
        sourceApi: "chat-completions",
        payload: buildResponsesTargetRequest(payload),
        githubToken,
        accountType,
        fetchOptions: plan.fetchOptions,
      });

      return await respondChatCompletions(
        c,
        withTranslatedEvents(result, translateResponsesToSourceEvents),
        plan.wantsStream,
      );
    }

    return await respondChatCompletions(
      c,
      await emitToChatCompletions({
        sourceApi: "chat-completions",
        payload,
        githubToken,
        accountType,
        fetchOptions: plan.fetchOptions,
      }),
      plan.wantsStream,
    );
  } catch (error) {
    return await respondChatCompletions(
      c,
      internalErrorResult(502, toInternalDebugError(error, "chat-completions")),
      false,
    );
  }
};
