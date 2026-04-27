import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";

/**
 * `eager_input_streaming` is a per-tool property in the Anthropic Messages API
 * that enables fine-grained tool input streaming. Copilot's upstream rejects it
 * with `"tools.N.custom.eager_input_streaming: Extra inputs are not permitted"`.
 */
export const withEagerInputStreamingStripped: TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
> = async (ctx, run) => {
  if (ctx.payload.tools) {
    ctx.payload.tools = ctx.payload.tools.map((tool) => {
      const { eager_input_streaming: _, ...rest } =
        tool as typeof tool & { eager_input_streaming?: unknown };
      return rest;
    });
  }

  return await run();
};
