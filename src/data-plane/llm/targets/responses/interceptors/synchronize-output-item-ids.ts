import type { ResponsesPayload } from "../../../../../lib/responses-types.ts";
import type { ResponsesResult } from "../../../../../lib/responses-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";

/**
 * Copilot `/responses` streams have been seen to emit one `item.id` on
 * `response.output_item.added` and a different `item.id` on the matching
 * `response.output_item.done` for the same `output_index`. Downstream clients
 * then treat one logical output item as two separate objects.
 *
 * We pin the id from `.added` and force `.done` to reuse it.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/736afa499133a20c83734f2226f2e9639fd23a31
 * - https://github.com/caozhiyuan/copilot-api/commit/4f22448a56b77ac5e5c93e6cdfc24724d3bfdcc7
 */
interface StreamIdTracker {
  outputItemIds: Map<number, string>;
}

const fixResponsesStreamIds = (
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string => {
  if (
    event !== "response.output_item.added" &&
    event !== "response.output_item.done"
  ) return data;

  try {
    const parsed = JSON.parse(data) as {
      output_index?: number;
      item?: { id?: string };
    };

    if (typeof parsed.output_index !== "number" || !parsed.item?.id) {
      return data;
    }

    if (event === "response.output_item.added") {
      tracker.outputItemIds.set(parsed.output_index, parsed.item.id);
      return data;
    }

    const originalId = tracker.outputItemIds.get(parsed.output_index);
    if (!originalId || parsed.item.id === originalId) return data;

    parsed.item.id = originalId;
    return JSON.stringify(parsed);
  } catch {
    return data;
  }
};

export const withOutputItemIdsSynchronized: TargetInterceptor<
  { payload: ResponsesPayload },
  ResponsesResult
> = async (_ctx, run) => {
  const result = await run();
  if (result.type !== "events") return result;

  const tracker: StreamIdTracker = { outputItemIds: new Map() };

  return {
    type: "events",
    events: (async function* () {
      for await (const frame of result.events) {
        yield frame.type === "sse"
          ? {
            ...frame,
            data: fixResponsesStreamIds(frame.data, frame.event, tracker),
          }
          : frame;
      }
    })(),
  };
};
