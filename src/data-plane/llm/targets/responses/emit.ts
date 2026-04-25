import { copilotFetch } from "../../../../lib/copilot.ts";
import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../../lib/responses-types.ts";
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
import { responsesTargetInterceptors } from "./interceptors/index.ts";

export const emitToResponses = async (
  input: EmitInput<ResponsesPayload>,
): Promise<EmitResult<ResponsesResult>> => {
  try {
    input.payload.stream = true;

    return await runTargetInterceptors<
      EmitInput<ResponsesPayload>,
      ResponsesResult
    >(
      input,
      responsesTargetInterceptors,
      async () => {
        const response = await copilotFetch(
          "/responses",
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
              "responses",
            ),
          );
        }

        if (isSSEResponse(response)) {
          return eventResult(parseSSEStream(response.body));
        }

        return eventResult((async function* () {
          yield jsonFrame(await response.json() as ResponsesResult);
        })());
      },
    );
  } catch (error) {
    return internalErrorResult(
      502,
      toInternalDebugError(error, input.sourceApi, "responses"),
    );
  }
};
