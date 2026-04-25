import type { ResponsesPayload } from "../../../../../lib/responses-types.ts";
import { normalizeModelName } from "../../../../../lib/model-name.ts";
import { fixApplyPatchTools } from "./fix-apply-patch-tools.ts";

export const normalizeResponsesRequest = (
  payload: ResponsesPayload,
): ResponsesPayload => {
  if (typeof payload.model === "string") {
    payload.model = normalizeModelName(payload.model);
  }
  fixApplyPatchTools(payload);
  return payload;
};
