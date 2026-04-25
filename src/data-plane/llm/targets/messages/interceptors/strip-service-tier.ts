import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";

/**
 * `service_tier` is part of Messages, but Copilot does not expose a compatible
 * knob on its native Messages or translated Chat Completions/Responses paths.
 * Strip it only after planning has committed to the native Messages target,
 * so source planning still sees the caller's real request.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/pull/45
 * - https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
 * - https://docs.anthropic.com/en/api/messages
 */
export const withServiceTierStripped: TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
> = async (ctx, run) => {
  const { service_tier: _, ...payload } = ctx.payload;
  ctx.payload = payload;

  return await run();
};
