import type { MessagesPayload } from "../../../../../lib/messages-types.ts";
import { normalizeModelName } from "../../../../../lib/model-name.ts";
import { stripMessagesBillingAttribution } from "./strip-billing-attribution.ts";
import { stripMessagesCacheControlScope } from "./strip-cache-control-scope.ts";
import { stripUnsupportedMessagesTools } from "./strip-unsupported-tools.ts";

export const normalizeMessagesRequest = (
  payload: MessagesPayload,
): MessagesPayload => {
  if (typeof payload.model === "string") {
    payload.model = normalizeModelName(payload.model);
  }

  stripUnsupportedMessagesTools(payload);
  stripMessagesBillingAttribution(payload);
  stripMessagesCacheControlScope(payload);

  return payload;
};
