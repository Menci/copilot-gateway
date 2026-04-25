import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import { getModelCapabilities } from "../../../shared/models/get-model-capabilities.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";

/**
 * Messages requires `max_tokens`, but translated Chat Completions and
 * Responses requests may omit their output-token cap entirely.
 *
 * We only synthesize this value after planning has committed to the Messages
 * target, so pairwise translation stays literal and native Messages callers
 * keep their own request untouched.
 *
 * Prefer the model's advertised `/models` output cap when Copilot exposes one.
 * Other gateways take the same general approach: `copilot-api` fills missing
 * Chat Completions `max_tokens` from model capabilities, and LiteLLM first
 * asks its model registry before falling back to a provider default.
 *
 * `8192` remains the last-resort gateway policy default when we cannot infer a
 * model cap. There is no single ecosystem standard catch-all value here:
 * `new-api` defaults Claude to `8192`, while `one-api` and LiteLLM use `4096`.
 * Keeping `8192` only as the final fallback matches our existing behavior while
 * still preferring a model-derived value whenever `/models` can tell us one.
 *
 * References:
 * - https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/routes/chat-completions/handler.ts
 * - https://github.com/BerriAI/litellm/blob/e9e86ed956ba53d5192e10b75634fe0246e836a7/litellm/llms/anthropic/chat/transformation.py
 * - https://github.com/QuantumNous/new-api/blob/65b16547329625f619cf797ae1eb9b748525056c/setting/model_setting/claude.go
 * - https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/relay/adaptor/anthropic/main.go
 */
export const withMissingMaxTokensFilled: TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
> = async (ctx, run) => {
  if (ctx.sourceApi !== "messages" && ctx.payload.max_tokens == null) {
    const { maxOutputTokens } = await getModelCapabilities(
      ctx.payload.model,
      ctx.githubToken,
      ctx.accountType,
    );

    ctx.payload.max_tokens = maxOutputTokens ?? 8192;
  }

  return await run();
};
