import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";

/**
 * Messages SSE streams do not terminate with Chat Completions-style
 * `data: [DONE]`, but Copilot's native `/v1/messages` path sometimes appends
 * one anyway. Stripping it here keeps the rest of the stream byte-for-byte
 * Messages-shaped.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/665bfe5f1fd2f8b875fa502449ff3d0fcbd85fa5
 */
export const withDoneSentinelStripped: TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
> = async (_ctx, run) => {
  const result = await run();
  if (result.type !== "events") return result;

  return {
    type: "events",
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type === "sse" && frame.data.trim() === "[DONE]") continue;
        yield frame;
      }
    })(),
  };
};
