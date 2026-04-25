import type { CopilotFetchOptions } from "../../../lib/copilot.ts";
import type { ExecuteResult } from "../shared/errors/result.ts";
import type { StreamFrame } from "../shared/stream/types.ts";
import type { SourceApi } from "../shared/types/source-api.ts";

export interface EmitInput<TPayload> {
  sourceApi: SourceApi;
  payload: TPayload;
  githubToken: string;
  accountType: string;
  fetchOptions?: CopilotFetchOptions;
}

export type EmitResult<TJson> = ExecuteResult<StreamFrame<TJson>>;
