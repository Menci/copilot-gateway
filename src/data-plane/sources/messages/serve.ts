import type { Context } from "hono";
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../../lib/anthropic-types.ts";
import { getGithubCredentials } from "../../../lib/github.ts";
import { normalizeMessagesRequest } from "./normalize/request.ts";
import { planMessagesRequest } from "./plan.ts";
import { buildTargetRequest as buildChatTargetRequest } from "../../translate/messages-via-chat-completions/build-target-request.ts";
import { buildTargetRequest as buildResponsesTargetRequest } from "../../translate/messages-via-responses/build-target-request.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { translateToSourceEvents as translateResponsesToSourceEvents } from "../../translate/messages-via-responses/translate-to-source-events.ts";
import { translateToSourceEvents as translateChatToSourceEvents } from "../../translate/messages-via-chat-completions/translate-to-source-events.ts";
import { respondMessages } from "./respond.ts";
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
  ) => AsyncIterable<StreamFrame<AnthropicResponse>>,
): StreamExecuteResult<AnthropicResponse> =>
  result.type === "events"
    ? { type: "events", events: translate(result.events) }
    : result;

export const serveMessages = async (
  c: Context,
): Promise<Response> => {
  try {
    const payload = await c.req.json<AnthropicMessagesPayload>();
    normalizeMessagesRequest(payload);
    c.set("model", payload.model || "unknown");

    const { token: githubToken, accountType } = await getGithubCredentials();
    const plan = await planMessagesRequest(
      payload,
      githubToken,
      accountType,
      c.req.header("anthropic-beta"),
    );

    if (plan.target === "messages") {
      return await respondMessages(
        c,
        await emitToMessages({
          sourceApi: "messages",
          payload,
          githubToken,
          accountType,
          fetchOptions: plan.fetchOptions,
          rawBeta: plan.rawBeta,
        }),
        plan.wantsStream,
      );
    }

    if (plan.target === "responses") {
      const result = await emitToResponses({
        sourceApi: "messages",
        payload: buildResponsesTargetRequest(payload, {
          reasoningEffort: plan.reasoningEffort,
        }),
        githubToken,
        accountType,
        fetchOptions: plan.fetchOptions,
      });

      return await respondMessages(
        c,
        withTranslatedEvents(result, translateResponsesToSourceEvents),
        plan.wantsStream,
      );
    }

    const result = await emitToChatCompletions({
      sourceApi: "messages",
      payload: buildChatTargetRequest(payload),
      githubToken,
      accountType,
      fetchOptions: plan.fetchOptions,
    });

    return await respondMessages(
      c,
      withTranslatedEvents(result, translateChatToSourceEvents),
      plan.wantsStream,
    );
  } catch (error) {
    return await respondMessages(
      c,
      internalErrorResult(502, toInternalDebugError(error, "messages")),
      false,
    );
  }
};
