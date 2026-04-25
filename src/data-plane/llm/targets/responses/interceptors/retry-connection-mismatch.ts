import { getRepo } from "../../../../../repo/index.ts";
import type { ResponsesPayload } from "../../../../../lib/responses-types.ts";
import type { ResponsesResult } from "../../../../../lib/responses-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";

/**
 * Copilot's `/responses` input item ids can be connection-bound. Once the
 * upstream session expires, replaying those ids yields
 * `input item ID does not belong to this connection`.
 *
 * The gateway remembers offending ids for one hour, rewrites them to short
 * stable gateway ids, and retries exactly once. The rewrite is deterministic so
 * a repeated retry uses the same replacement id instead of causing extra prompt
 * cache churn.
 *
 * References:
 * - https://github.com/Menci/copilot-gateway/commit/f70e378cc18c3e0523354bfcd64691473a9aa206
 */
const SPOTTED_ID_PREFIX = "spotted_invalid_id:";
const SPOTTED_ID_TTL_MS = 3600_000;

const isBase64Id = (id: string): boolean => {
  if (id.length < 20) return false;

  try {
    atob(id);
    return true;
  } catch {
    return false;
  }
};

const deriveReplacementId = async (
  type: string,
  originalId: string,
): Promise<string> => {
  // Stable hash-derived ids keep retries repeatable and preserve cacheability
  // better than generating a new random id for the same upstream-broken item.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(originalId),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  const prefix = type === "reasoning"
    ? "rs"
    : type === "function_call"
    ? "fc"
    : "msg";

  return `${prefix}_${hex}`;
};

const markIdsAsInvalid = async (ids: string[]): Promise<void> => {
  const cache = getRepo().cache;
  await Promise.all(
    ids.map((id) =>
      cache.set(`${SPOTTED_ID_PREFIX}${id}`, "1", SPOTTED_ID_TTL_MS)
    ),
  );
};

const replaceSpottedResponseIds = async (
  payload: ResponsesPayload,
): Promise<boolean> => {
  if (!Array.isArray(payload.input)) return false;

  const itemsWithId = payload.input.filter((item) =>
    typeof (item as { id?: unknown }).id === "string" &&
    Boolean((item as { id?: string }).id)
  );
  if (itemsWithId.length === 0) return false;

  const originalIds = itemsWithId.map((item) => (item as { id: string }).id);
  const cache = getRepo().cache;
  const results = await Promise.all(
    originalIds.map((id) => cache.get(`${SPOTTED_ID_PREFIX}${id}`)),
  );

  let replaced = false;
  const refreshedIds: string[] = [];

  for (let index = 0; index < itemsWithId.length; index++) {
    if (results[index] === null) continue;

    const item = itemsWithId[index] as { id: string; type?: string };
    item.id = await deriveReplacementId(
      item.type || "message",
      originalIds[index],
    );
    replaced = true;
    refreshedIds.push(originalIds[index]);
  }

  if (refreshedIds.length > 0) await markIdsAsInvalid(refreshedIds);
  return replaced;
};

const collectBase64Ids = (payload: ResponsesPayload): string[] => {
  if (!Array.isArray(payload.input)) return [];

  return payload.input.flatMap((item) => {
    const id = (item as { id?: unknown }).id;
    return typeof id === "string" && isBase64Id(id) ? [id] : [];
  });
};

const isConnectionMismatchError = (body: unknown): boolean => {
  const message = (body as { error?: { message?: unknown } }).error?.message;
  return typeof message === "string" &&
    message.includes("input item ID does not belong to this connection");
};

const isConnectionMismatchUpstreamError = (
  body: Uint8Array,
): boolean => {
  try {
    return isConnectionMismatchError(
      JSON.parse(new TextDecoder().decode(body)),
    );
  } catch {
    return false;
  }
};

export const withConnectionMismatchRetried: TargetInterceptor<
  { payload: ResponsesPayload },
  ResponsesResult
> = async (ctx, run) => {
  await replaceSpottedResponseIds(ctx.payload);

  const first = await run();
  if (
    first.type !== "upstream-error" ||
    !isConnectionMismatchUpstreamError(first.body)
  ) {
    return first;
  }

  const base64Ids = collectBase64Ids(ctx.payload);
  if (base64Ids.length === 0) return first;

  await markIdsAsInvalid(base64Ids);
  await replaceSpottedResponseIds(ctx.payload);
  return await run();
};
