import type { MessagesPayload } from "../../../../../lib/messages-types.ts";

/**
 * Copilot's native `/v1/messages` surface only accepts the fields defined in
 * `MessagesClientTool` for client-provided (custom) tools.  Any extra
 * top-level properties — such as `eager_input_streaming` sent by the
 * Anthropic SDK — cause a 400 "Extra inputs are not permitted" rejection.
 *
 * We also filter out `web_search` tools which Copilot does not support.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/3c12f580bf4d269ab18838bcc259a89719f8a2cd
 * - https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
 */

/** Fields that Copilot accepts on a client (custom) tool definition. */
const ALLOWED_CLIENT_TOOL_KEYS = new Set([
  "type",
  "name",
  "description",
  "input_schema",
  "strict",
  "cache_control",
]);

export const stripUnsupportedMessagesTools = (
  payload: MessagesPayload,
): void => {
  if (!payload.tools) return;

  // Remove unsupported tool types (e.g. web_search)
  payload.tools = payload.tools.filter((tool) =>
    (tool as unknown as Record<string, unknown>).type !== "web_search"
  );

  // Strip unknown top-level keys from client tools so Copilot doesn't reject
  // them.  Properties like `eager_input_streaming` are valid in the Anthropic
  // API but not accepted by Copilot's stricter schema.
  for (const tool of payload.tools) {
    const record = tool as unknown as Record<string, unknown>;
    // Only sanitize client (custom) tools, not server/native tool types
    if (record.type === undefined || record.type === "custom") {
      for (const key of Object.keys(record)) {
        if (!ALLOWED_CLIENT_TOOL_KEYS.has(key)) {
          delete record[key];
        }
      }
    }
  }

  if (payload.tools.length === 0) delete payload.tools;
};
