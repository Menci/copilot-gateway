import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";

/**
 * Native Copilot `/v1/messages` rejects GPT-origin placeholder / empty
 * thinking blocks. This stays in the native Messages target so translated paths
 * can preserve their own source-specific placeholder behavior.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/de08ef3f115de4ea0e7f2e6088e7133bcc20854d
 * - https://github.com/caozhiyuan/copilot-api/pull/72
 */
export const withInvalidThinkingBlocksFiltered: TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
> = async (ctx, run) => {
  for (const message of ctx.payload.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    message.content = message.content.filter((block) =>
      block.type !== "thinking" ||
      (Boolean(block.thinking) && block.thinking !== "Thinking...")
    );
  }

  return await run();
};
