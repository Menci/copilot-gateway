import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";

/**
 * Copilot's native `/v1/messages` endpoint does not accept the full public
 * `anthropic-beta` surface. Forwarding unknown betas has caused 400s in
 * practice; `context-1m-2025-08-07` was removed for that reason in commit
 * `f9bf6ab`.
 *
 * We therefore rebuild the header from an allowlist that matches the native
 * beta set we intentionally support on this gateway.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/b2dbf9d57612bdf75e87f71993567bd5315b22b5
 * - https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 */
const ALLOWED_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "advanced-tool-use-2025-11-20",
]);

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

const filterBetaHeader = (
  header: string | undefined,
  isAdaptiveThinking: boolean,
): string | undefined => {
  if (!header) return undefined;

  let filtered = header.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && ALLOWED_BETAS.has(value));

  if (isAdaptiveThinking) {
    filtered = filtered.filter((value) => value !== INTERLEAVED_THINKING_BETA);
  }

  return filtered.length > 0 ? [...new Set(filtered)].join(",") : undefined;
};

export const withBetaHeaderFixed: TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
> = async (ctx, run) => {
  const isAdaptiveThinking = ctx.payload.thinking?.type === "adaptive";
  let betaHeader = filterBetaHeader(ctx.rawBeta, isAdaptiveThinking);

  if (
    ctx.payload.thinking?.budget_tokens &&
    !isAdaptiveThinking &&
    !betaHeader?.includes(INTERLEAVED_THINKING_BETA)
  ) {
    /**
     * Non-adaptive extended thinking with tool use needs the
     * `interleaved-thinking-2025-05-14` beta. Doing this at the target
     * boundary means both native callers and translated callers get the same
     * native `/v1/messages` behavior once planning has chosen that target.
     *
     * References:
     * - https://github.com/caozhiyuan/copilot-api/commit/b2dbf9d57612bdf75e87f71993567bd5315b22b5
     * - https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
     */
    betaHeader = betaHeader
      ? `${betaHeader},${INTERLEAVED_THINKING_BETA}`
      : INTERLEAVED_THINKING_BETA;
  }

  if (betaHeader) {
    ctx.fetchOptions = ctx.fetchOptions
      ? {
        ...ctx.fetchOptions,
        extraHeaders: { "anthropic-beta": betaHeader },
      }
      : { extraHeaders: { "anthropic-beta": betaHeader } };
  }

  return await run();
};
