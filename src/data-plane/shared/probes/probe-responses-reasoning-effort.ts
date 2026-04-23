import {
  selectResponsesReasoningEffortForAnthropic,
} from "../../../lib/copilot-probes.ts";
import type { AnthropicMessagesPayload } from "../../../lib/anthropic-types.ts";

export const probeResponsesReasoningEffortForMessages = async (
  payload: AnthropicMessagesPayload,
  githubToken: string,
  accountType: string,
) =>
  await selectResponsesReasoningEffortForAnthropic(
    payload,
    githubToken,
    accountType,
  );
