import type { Context } from "hono";
import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../../lib/responses-types.ts";
import { getGithubCredentials } from "../../../../lib/github.ts";
import { normalizeResponsesRequest } from "./normalize/request.ts";
import { planResponsesRequest } from "./plan.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../../translate/responses-via-messages/build-target-request.ts";
import { buildTargetRequest as buildChatCompletionsTargetRequest } from "../../translate/responses-via-chat-completions/build-target-request.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { translateToSourceEvents } from "../../translate/responses-via-messages/translate-to-source-events.ts";
import { translateToSourceEvents as translateChatCompletionsToSourceEvents } from "../../translate/responses-via-chat-completions/translate-to-source-events.ts";
import { respondResponses } from "./respond.ts";
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
  ) => AsyncIterable<StreamFrame<ResponsesResult>>,
): StreamExecuteResult<ResponsesResult> =>
  result.type === "events"
    ? { type: "events", events: translate(result.events) }
    : result;

const unsupportedResponsesModelResponse = (model: string): Response =>
  Response.json({
    error: {
      message: `Model ${model} does not support the /responses endpoint.`,
      type: "invalid_request_error",
    },
  }, { status: 400 });

const createTranslatedResponseId = (): string =>
  `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

export const serveResponses = async (
  c: Context,
): Promise<Response> => {
  try {
    const payload = await c.req.json<ResponsesPayload>();
    normalizeResponsesRequest(payload);
    c.set("model", payload.model || "unknown");

    const { token: githubToken, accountType } = await getGithubCredentials();
    const plan = await planResponsesRequest(payload, githubToken, accountType);
    if (!plan) return unsupportedResponsesModelResponse(payload.model);

    if (plan.target === "responses") {
      return await respondResponses(
        c,
        await emitToResponses({
          sourceApi: "responses",
          payload,
          githubToken,
          accountType,
          fetchOptions: plan.fetchOptions,
        }),
        plan.wantsStream,
      );
    }

    if (plan.target === "messages") {
      const messagesPayload = buildMessagesTargetRequest(payload);
      const result = await emitToMessages({
        sourceApi: "responses",
        payload: messagesPayload,
        githubToken,
        accountType,
        fetchOptions: plan.fetchOptions,
      });

      return await respondResponses(
        c,
        withTranslatedEvents(
          result,
          (events) =>
            translateToSourceEvents(
              events,
              createTranslatedResponseId(),
              messagesPayload.model,
            ),
        ),
        plan.wantsStream,
      );
    }

    const chatPayload = buildChatCompletionsTargetRequest(payload);
    const result = await emitToChatCompletions({
      sourceApi: "responses",
      payload: chatPayload,
      githubToken,
      accountType,
      fetchOptions: plan.fetchOptions,
    });

    return await respondResponses(
      c,
      withTranslatedEvents(result, translateChatCompletionsToSourceEvents),
      plan.wantsStream,
    );
  } catch (error) {
    return await respondResponses(
      c,
      internalErrorResult(502, toInternalDebugError(error, "responses")),
      false,
    );
  }
};
