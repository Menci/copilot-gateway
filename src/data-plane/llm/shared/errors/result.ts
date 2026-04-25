import type { InternalDebugError } from "./internal-debug-error.ts";
import type { StreamFrame } from "../stream/types.ts";

export interface EventResult<T> {
  type: "events";
  events: AsyncIterable<T>;
}

export interface UpstreamErrorResult {
  type: "upstream-error";
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface InternalErrorResult {
  type: "internal-error";
  status: number;
  error: InternalDebugError;
}

export type ExecuteResult<T> =
  | EventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult;

export type StreamExecuteResult<T> = ExecuteResult<StreamFrame<T>>;

export const eventResult = <T>(events: AsyncIterable<T>): EventResult<T> => ({
  type: "events",
  events,
});

export const internalErrorResult = (
  status: number,
  error: InternalDebugError,
): InternalErrorResult => ({
  type: "internal-error",
  status,
  error,
});
