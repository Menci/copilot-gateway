import type { Context } from "hono";
import type { InternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import type { ResponsesResult } from "../../../../lib/responses-types.ts";
import {
  collectResponsesEventsToResult,
  expandResponsesFrames,
} from "./collect/from-events.ts";
import { responsesSourceInterceptors } from "./interceptors/index.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import { runSourceInterceptors } from "../run-interceptors.ts";

const internalResponsesErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response =>
  Response.json({
    error: {
      type: error.type,
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
      source_api: error.source_api,
      target_api: error.target_api,
    },
  }, { status });

export const respondResponses = async (
  c: Context,
  initialResult: StreamExecuteResult<ResponsesResult>,
  wantsStream: boolean,
): Promise<Response> => {
  const result = await runSourceInterceptors(
    initialResult,
    responsesSourceInterceptors,
  );

  if (result.type === "upstream-error") return upstreamErrorToResponse(result);
  if (result.type === "internal-error") {
    return internalResponsesErrorResponse(result.status, result.error);
  }

  return wantsStream
    ? proxySSE(c, expandResponsesFrames(result.events))
    : Response.json(await collectResponsesEventsToResult(result.events));
};
