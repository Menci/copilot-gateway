import { copilotFetch } from "../../../lib/copilot.ts";
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../lib/openai-types.ts";
import { isSSEResponse } from "../../../lib/sse-reassemble.ts";
import { readUpstreamError } from "../../shared/errors/upstream-error.ts";
import {
  eventResult,
  internalErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { parseSSEStream } from "../../shared/stream/parse-sse.ts";
import { jsonFrame } from "../../shared/stream/types.ts";
import { runTargetInterceptors } from "../run-interceptors.ts";
import type { EmitInput, EmitResult } from "../emit-types.ts";
import { chatCompletionsTargetInterceptors } from "./interceptors/index.ts";

export interface EmitToChatCompletionsInput
  extends EmitInput<ChatCompletionsPayload> {}

export const emitToChatCompletions = async (
  input: EmitToChatCompletionsInput,
): Promise<EmitResult<ChatCompletionResponse>> => {
  try {
    return await runTargetInterceptors<
      EmitToChatCompletionsInput,
      ChatCompletionResponse
    >(
      input,
      chatCompletionsTargetInterceptors,
      async () => {
        const response = await copilotFetch(
          "/chat/completions",
          {
            method: "POST",
            body: JSON.stringify(input.payload),
          },
          input.githubToken,
          input.accountType,
          input.fetchOptions,
        );

        if (!response.ok) return await readUpstreamError(response);
        if (!response.body) {
          return internalErrorResult(
            502,
            toInternalDebugError(
              new Error("No response body from upstream"),
              input.sourceApi,
              "chat-completions",
            ),
          );
        }

        if (isSSEResponse(response)) {
          return eventResult(parseSSEStream(response.body));
        }

        return eventResult((async function* () {
          yield jsonFrame(await response.json() as ChatCompletionResponse);
        })());
      },
    );
  } catch (error) {
    return internalErrorResult(
      502,
      toInternalDebugError(error, input.sourceApi, "chat-completions"),
    );
  }
};
