import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../../../lib/responses-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitInput } from "../../emit-types.ts";

/**
 * Some Copilot `/responses` paths have rejected Claude Code-sized
 * `max_tokens` values after Messages -> Responses translation. A widely used
 * Copilot proxy applies the same `Math.max(..., 12800)` compatibility floor
 * after reports that `gpt-5-mini` was incompatible with Claude Code's
 * `max_tokens = 512` requests.
 *
 * Keep this fix at the Responses target so pairwise translation preserves the
 * source request, and only Messages-origin traffic picks up this Copilot-
 * specific workaround.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/32cb10a1ce2deffdc4a2aa5b500339aa03d2528b
 */
export const withSmallMaxOutputTokensRaised: TargetInterceptor<
  EmitInput<ResponsesPayload>,
  ResponsesResult
> = async (ctx, run) => {
  if (
    ctx.sourceApi === "messages" &&
    ctx.payload.max_output_tokens != null &&
    ctx.payload.max_output_tokens < 12800
  ) {
    ctx.payload.max_output_tokens = 12800;
  }

  return await run();
};
