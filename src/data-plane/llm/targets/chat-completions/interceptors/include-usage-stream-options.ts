import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../../../lib/chat-completions-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";

/**
 * Chat Completions streaming only includes the final usage-only chunk when
 * `stream_options.include_usage` is enabled. We force that on here because
 * the gateway's source responders and usage tracking rely on those usage
 * frames for both streaming passthrough and non-stream reassembly.
 *
 * References:
 * - https://platform.openai.com/docs/api-reference/chat/create
 */
export const withUsageStreamOptionsIncluded: TargetInterceptor<
  { payload: ChatCompletionsPayload },
  ChatCompletionResponse
> = async (ctx, run) => {
  ctx.payload.stream = true;
  ctx.payload.stream_options = ctx.payload.stream_options
    ? { ...ctx.payload.stream_options, include_usage: true }
    : { include_usage: true };

  return await run();
};
