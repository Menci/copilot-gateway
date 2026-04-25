import type { SourceApi } from "../types/source-api.ts";
import type { TargetApi } from "../types/target-api.ts";

export interface InternalDebugError {
  type: "internal_error";
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  source_api: SourceApi;
  target_api?: TargetApi;
}

const serializeCause = (cause: unknown): unknown => {
  if (!(cause instanceof Error)) return cause;

  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
    cause: serializeCause(cause.cause),
  };
};

export const toInternalDebugError = (
  error: unknown,
  sourceApi: SourceApi,
  targetApi?: TargetApi,
): InternalDebugError => {
  const known = error instanceof Error ? error : new Error(String(error));

  return {
    type: "internal_error",
    name: known.name,
    message: known.message,
    stack: known.stack,
    cause: serializeCause(known.cause),
    source_api: sourceApi,
    ...(targetApi ? { target_api: targetApi } : {}),
  };
};
