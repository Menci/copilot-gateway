import type { Context } from "hono";
import { copilotFetch, type CopilotFetchOptions } from "../lib/copilot.ts";
import { getGithubCredentials } from "../lib/github.ts";
import { modelSupportsEndpoint } from "../lib/models-cache.ts";
import type { ResponsesPayload } from "../lib/responses-types.ts";
import type { AnthropicResponse } from "../lib/anthropic-types.ts";
import {
  translateAnthropicToResponsesResult,
  translateResponsesToAnthropicPayload,
} from "../lib/translate/responses.ts";
import { filterThinkingBlocks } from "../lib/translate/utils.ts";
import {
  createAnthropicToResponsesStreamState,
  translateAnthropicEventToResponsesEvents,
} from "../lib/translate/anthropic-to-responses-stream.ts";
import { proxySSE } from "../lib/sse.ts";
import {
  isSSEResponse,
  reassembleAnthropicSSE,
  reassembleResponsesSSE,
} from "../lib/sse-reassemble.ts";
import {
  apiErrorResponse,
  copilotApiErrorResponse,
  getErrorMessage,
  noUpstreamBodyApiErrorResponse,
} from "./proxy-utils.ts";

function hasVision(payload: ResponsesPayload): boolean {
  const input = payload.input;
  if (!Array.isArray(input)) return false;
  return input.some((item) =>
    item.type === "message" && "content" in item &&
    Array.isArray(item.content) &&
    // deno-lint-ignore no-explicit-any
    item.content.some((block: any) =>
      block.type === "input_image" || block.type === "image"
    )
  );
}

function getInitiator(payload: ResponsesPayload): "user" | "agent" {
  const input = payload.input;
  if (!Array.isArray(input)) return "user";
  const lastItem = input[input.length - 1];
  return lastItem?.type === "function_call_output" ? "agent" : "user";
}

/**
 * XXX: Workaround for Copilot API not supporting "custom" tool type.
 * Codex CLI sends apply_patch as { type: "custom", name: "apply_patch" },
 * but Copilot only understands "function" tools.
 */
function fixApplyPatchTools(payload: ResponsesPayload): void {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return;
  for (let i = 0; i < tools.length; i++) {
    // deno-lint-ignore no-explicit-any
    const t = tools[i] as any;
    if (t.type === "custom" && t.name === "apply_patch") {
      tools[i] = {
        type: "function",
        name: "apply_patch",
        description: "Use the `apply_patch` tool to edit files",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", description: "The entire contents of the apply_patch command" },
          },
          required: ["input"],
          additionalProperties: false,
        },
        strict: false,
      };
    }
  }
}

/**
 * Fix Copilot API inconsistency: item IDs may differ between
 * response.output_item.added and response.output_item.done events.
 */
interface StreamIdTracker {
  outputItemIds: Map<number, string>;
}

function fixStreamIds(
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string {
  if (
    event !== "response.output_item.added" &&
    event !== "response.output_item.done"
  ) return data;

  try {
    const parsed = JSON.parse(data);
    const outputIndex = parsed.output_index;
    if (typeof outputIndex !== "number" || !parsed.item?.id) return data;

    if (event === "response.output_item.added") {
      tracker.outputItemIds.set(outputIndex, parsed.item.id);
      return data;
    }

    const originalId = tracker.outputItemIds.get(outputIndex);
    if (originalId && parsed.item.id !== originalId) {
      parsed.item.id = originalId;
      return JSON.stringify(parsed);
    }
    return data;
  } catch {
    return data;
  }
}

export const responses = async (c: Context) => {
  try {
    const payload = await c.req.json<ResponsesPayload>();
    const { token: githubToken, accountType } = await getGithubCredentials();
    const model = payload.model;

    const supportsResponses = await modelSupportsEndpoint(
      model,
      "/responses",
      githubToken,
      accountType,
    );
    if (supportsResponses) {
      return await handleDirectResponses(c, payload, githubToken, accountType);
    }

    const supportsMessages = await modelSupportsEndpoint(
      model,
      "/v1/messages",
      githubToken,
      accountType,
    );
    if (supportsMessages) {
      return await handleViaMessages(c, payload, githubToken, accountType);
    }

    return c.json({
      error: {
        message: `Model ${model} does not support the /responses endpoint.`,
        type: "invalid_request_error",
      },
    }, 400);
  } catch (e: unknown) {
    return apiErrorResponse(c, getErrorMessage(e), 502);
  }
};

async function handleDirectResponses(
  c: Context,
  payload: ResponsesPayload,
  githubToken: string,
  accountType: string,
): Promise<Response> {
  fixApplyPatchTools(payload);

  const wantsStream = payload.stream === true;

  // Always stream upstream to avoid blocking on large responses
  payload.stream = true;

  const resp = await copilotFetch(
    "/responses",
    { method: "POST", body: JSON.stringify(payload) },
    githubToken,
    accountType,
    { vision: hasVision(payload), initiator: getInitiator(payload) },
  );

  if (!resp.ok) {
    const text = await resp.text();
    return copilotApiErrorResponse(
      c,
      resp.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
      text,
    );
  }

  if (!wantsStream) {
    if (resp.body && isSSEResponse(resp)) {
      return c.json(await reassembleResponsesSSE(resp.body));
    }
    return c.json(await resp.json());
  }

  if (!resp.body) return noUpstreamBodyApiErrorResponse(c);

  const idTracker: StreamIdTracker = { outputItemIds: new Map() };
  return proxySSE(c, resp.body, (event, data) => {
    const fixedData = fixStreamIds(data, event || undefined, idTracker);
    return [{ event: event || undefined, data: fixedData }];
  }, "Responses");
}

async function handleViaMessages(
  c: Context,
  payload: ResponsesPayload,
  githubToken: string,
  accountType: string,
): Promise<Response> {
  fixApplyPatchTools(payload);

  const anthropicPayload = translateResponsesToAnthropicPayload(payload);
  filterThinkingBlocks(anthropicPayload);
  const wantsStream = !!anthropicPayload.stream;
  const fetchOptions: CopilotFetchOptions = {
    vision: hasVision(payload),
    initiator: getInitiator(payload),
  };

  // Always stream upstream to avoid blocking on large responses
  anthropicPayload.stream = true;

  const resp = await copilotFetch(
    "/v1/messages",
    { method: "POST", body: JSON.stringify(anthropicPayload) },
    githubToken,
    accountType,
    fetchOptions,
  );

  if (!resp.ok) {
    const text = await resp.text();
    return copilotApiErrorResponse(
      c,
      resp.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
      text,
    );
  }

  if (!wantsStream) {
    let anthropicResponse: AnthropicResponse;
    if (resp.body && isSSEResponse(resp)) {
      anthropicResponse = await reassembleAnthropicSSE(resp.body);
    } else {
      anthropicResponse = await resp.json() as AnthropicResponse;
    }
    return c.json(translateAnthropicToResponsesResult(anthropicResponse));
  }

  if (!resp.body) return noUpstreamBodyApiErrorResponse(c);

  const responseId = `resp_${
    crypto.randomUUID().replace(/-/g, "").slice(0, 24)
  }`;
  const state = createAnthropicToResponsesStreamState(
    responseId,
    anthropicPayload.model,
  );

  return proxySSE(c, resp.body, (eventName, data) => {
    if (state.completed) return null;
    const trimmed = data.trim();
    if (!trimmed) return null;

    // deno-lint-ignore no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (eventName && !parsed.type) parsed.type = eventName;

    return translateAnthropicEventToResponsesEvents(parsed, state)
      .map((e) => ({ event: e.type, data: JSON.stringify(e) }));
  }, "Responses→Messages reverse translation");
}
