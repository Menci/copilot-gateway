import type { MessagesPayload } from "../../../../../lib/messages-types.ts";

/**
 * Messages exposes a built-in `web_search` tool, but Copilot's native
 * `/v1/messages` surface does not accept it today. We drop it at source
 * normalize so native and translated Messages routing start from the same
 * cleaned request.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/3c12f580bf4d269ab18838bcc259a89719f8a2cd
 * - https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
 */
export const stripUnsupportedMessagesTools = (
  payload: MessagesPayload,
): void => {
  if (!payload.tools) return;

  payload.tools = payload.tools.filter((tool) =>
    (tool as unknown as Record<string, unknown>).type !== "web_search"
  );

  if (payload.tools.length === 0) delete payload.tools;
};
