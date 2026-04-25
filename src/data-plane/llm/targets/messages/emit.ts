import { copilotFetch } from "../../../../lib/copilot.ts";
import type {
  MessagesResponse,
  MessagesTargetPayload,
} from "../../../../lib/messages-types.ts";
import { isSSEResponse } from "../../../../lib/sse-reassemble.ts";
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
import { messagesTargetInterceptors } from "./interceptors/index.ts";

export interface EmitToMessagesInput extends EmitInput<MessagesTargetPayload> {
  rawBeta?: string;
}

export const emitToMessages = async (
  input: EmitToMessagesInput,
): Promise<EmitResult<MessagesResponse>> => {
  try {
    input.payload.stream = true;

    return await runTargetInterceptors<EmitToMessagesInput, MessagesResponse>(
      input,
      messagesTargetInterceptors,
      async () => {
        const response = await copilotFetch(
          "/v1/messages",
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
              "messages",
            ),
          );
        }

        if (isSSEResponse(response)) {
          return eventResult(parseSSEStream(response.body));
        }

        return eventResult((async function* () {
          yield jsonFrame(await response.json() as MessagesResponse);
        })());
      },
    );
  } catch (error) {
    return internalErrorResult(
      502,
      toInternalDebugError(error, input.sourceApi, "messages"),
    );
  }
};
