import type { MessagesResponse } from "../../../../lib/messages-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";
import { withMissingMaxTokensFilled } from "./fill-missing-max-tokens.ts";
import { withBetaHeaderFixed } from "./fix-beta-header.ts";
import { withInvalidThinkingBlocksFiltered } from "./filter-invalid-thinking-blocks.ts";
import { withDoneSentinelStripped } from "./strip-done-sentinel.ts";
import { withServiceTierStripped } from "./strip-service-tier.ts";
import { withMessagesWebSearchShim } from "./web-search-shim.ts";

export const messagesTargetInterceptors = [
  withMessagesWebSearchShim,
  withMissingMaxTokensFilled,
  withInvalidThinkingBlocksFiltered,
  withBetaHeaderFixed,
  withServiceTierStripped,
  withDoneSentinelStripped,
] satisfies readonly TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
>[];
