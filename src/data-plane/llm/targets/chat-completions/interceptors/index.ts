import type { ChatCompletionResponse } from "../../../../../lib/chat-completions-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToChatCompletionsInput } from "../emit.ts";
import { withClaudeChoiceShapeFixed } from "./fix-claude-choice-shape.ts";
import { withUsageStreamOptionsIncluded } from "./include-usage-stream-options.ts";

export const chatCompletionsTargetInterceptors = [
  withUsageStreamOptionsIncluded,
  withClaudeChoiceShapeFixed,
] satisfies readonly TargetInterceptor<
  EmitToChatCompletionsInput,
  ChatCompletionResponse
>[];
