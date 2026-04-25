import type { MessagesPayload } from "../../../../../lib/messages-types.ts";

/**
 * Claude Code's prompt-caching-scope beta adds `cache_control.scope`, but
 * Copilot's native `/v1/messages` endpoint rejects that extra field with 400.
 * We strip only `scope` and keep the rest of `cache_control` intact so
 * ephemeral prompt caching still works.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/issues/143
 * - https://github.com/caozhiyuan/copilot-api/issues/144
 * - https://github.com/caozhiyuan/copilot-api/commit/ce8224c55933f811abe5bf9ba42f9336a7852997
 */
const stripBlockCacheControlScope = (
  block: Record<string, unknown>,
): void => {
  const cacheControl = block.cache_control;
  if (!cacheControl || typeof cacheControl !== "object") return;

  const { scope: _, ...rest } = cacheControl as Record<string, unknown>;
  block.cache_control = Object.keys(rest).length > 0 ? rest : undefined;
};

export const stripMessagesCacheControlScope = (
  payload: MessagesPayload,
): void => {
  if (Array.isArray(payload.system)) {
    for (
      const block of payload.system as unknown as Record<string, unknown>[]
    ) {
      stripBlockCacheControlScope(block);
    }
  }

  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue;

    for (
      const block of message.content as unknown as Record<string, unknown>[]
    ) {
      stripBlockCacheControlScope(block);
    }
  }
};
