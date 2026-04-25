import type { Context } from "hono";
import type { InternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import type { MessagesResponse } from "../../../../lib/messages-types.ts";
import {
  collectMessagesEventsToResponse,
  expandMessagesFrames,
} from "./collect/from-events.ts";
import { messagesSourceInterceptors } from "./interceptors/index.ts";
import { runSourceInterceptors } from "../run-interceptors.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";

const internalMessagesErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response =>
  Response.json({
    type: "error",
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

export const respondMessages = async (
  c: Context,
  initialResult: StreamExecuteResult<MessagesResponse>,
  wantsStream: boolean,
): Promise<Response> => {
  const result = await runSourceInterceptors(
    initialResult,
    messagesSourceInterceptors,
  );

  if (result.type === "upstream-error") {
    return upstreamErrorToResponse(result);
  }

  if (result.type === "internal-error") {
    return internalMessagesErrorResponse(result.status, result.error);
  }

  return wantsStream
    ? proxySSE(c, expandMessagesFrames(result.events))
    : Response.json(await collectMessagesEventsToResponse(result.events));
};
