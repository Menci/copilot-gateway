import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../../../lib/chat-completions-types.ts";
import { jsonFrame } from "../../../shared/stream/types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";

type ChatChoice = Record<string, unknown>;
type ChatResponse = Record<string, unknown>;

/**
 * Copilot's Claude `/chat/completions` adapter has been observed to split one
 * logical Messages-style answer across multiple Chat Completions choices.
 * That breaks clients expecting one assistant choice whose text, tool calls,
 * and finish reason stay together.
 *
 * For successful JSON responses we merge those split choices back into one; for
 * streaming responses we normalize every choice index to `0` so the client sees
 * one continuous completion.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/075ed78e7bffe2171e7085ccac42fdfef48a231d
 */
const mergeChatChoices = (data: ChatResponse): ChatResponse => {
  const choices = data.choices as ChatChoice[] | undefined;
  if (!Array.isArray(choices) || choices.length <= 1) return data;

  const merged: ChatChoice = { ...choices[0], index: 0 };
  const message = { ...(merged.message as Record<string, unknown>) };
  let content = typeof message.content === "string" ? message.content : "";
  const toolCalls = Array.isArray(message.tool_calls)
    ? [...message.tool_calls as unknown[]]
    : [];
  let finishReason = merged.finish_reason;

  for (let index = 1; index < choices.length; index++) {
    const choice = choices[index];
    const choiceMessage = choice.message as Record<string, unknown> | undefined;

    if (typeof choiceMessage?.content === "string") {
      content += choiceMessage.content;
    }

    if (Array.isArray(choiceMessage?.tool_calls)) {
      toolCalls.push(...choiceMessage.tool_calls);
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  message.content = content || null;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  merged.message = message;
  merged.finish_reason = finishReason;

  return { ...data, choices: [merged] };
};

const normalizeChatChunkChoiceIndices = (data: string): string => {
  if (data === "[DONE]") return data;

  try {
    const parsed = JSON.parse(data) as ChatResponse;
    const choices = parsed.choices as ChatChoice[] | undefined;
    if (!Array.isArray(choices)) return data;

    for (const choice of choices) {
      choice.index = 0;
    }

    return JSON.stringify(parsed);
  } catch {
    return data;
  }
};

export const withClaudeChoiceShapeFixed: TargetInterceptor<
  { payload: ChatCompletionsPayload },
  ChatCompletionResponse
> = async (ctx, run) => {
  const result = await run();
  if (result.type !== "events" || !ctx.payload.model.startsWith("claude")) {
    return result;
  }

  return {
    type: "events",
    events: (async function* () {
      for await (const frame of result.events) {
        yield frame.type === "json"
          ? jsonFrame(
            mergeChatChoices(
              frame.data as unknown as ChatResponse,
            ) as unknown as ChatCompletionResponse,
          )
          : { ...frame, data: normalizeChatChunkChoiceIndices(frame.data) };
      }
    })(),
  };
};
