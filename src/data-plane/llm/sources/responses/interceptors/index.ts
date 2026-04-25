import type { ResponsesResult } from "../../../../../lib/responses-types.ts";
import type { StreamExecuteResult } from "../../../shared/errors/result.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";

export const responsesSourceInterceptors =
  [] satisfies readonly SourceInterceptor<
    StreamExecuteResult<ResponsesResult>
  >[];
