import type { MessagesResponse } from "../../../../../lib/messages-types.ts";
import type { StreamExecuteResult } from "../../../shared/errors/result.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import { rewriteContextWindowError } from "./rewrite-context-window-error.ts";

export const messagesSourceInterceptors = [
  rewriteContextWindowError,
] satisfies readonly SourceInterceptor<StreamExecuteResult<MessagesResponse>>[];
