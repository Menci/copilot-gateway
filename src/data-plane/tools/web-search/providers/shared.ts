import { isRecord } from "../../../../lib/type-guards.ts";
import type { WebSearchProviderResult } from "../types.ts";

const MAX_WEB_SEARCH_QUERY_LENGTH = 1000;

export type ValidatedWebSearchQuery =
  | { type: "ok"; query: string }
  | { type: "error"; result: WebSearchProviderResult };

export const validateWebSearchQuery = (
  query: string,
): ValidatedWebSearchQuery => {
  const normalized = query.trim();
  if (normalized.length === 0) {
    return {
      type: "error",
      result: {
        type: "error",
        errorCode: "invalid_tool_input",
        message: "Search query must not be empty.",
      },
    };
  }

  if (normalized.length > MAX_WEB_SEARCH_QUERY_LENGTH) {
    return {
      type: "error",
      result: {
        type: "error",
        errorCode: "query_too_long",
        message: "Search query must be at most 1000 characters.",
      },
    };
  }

  return { type: "ok", query: normalized };
};

export const toWebSearchTextBlocks = (
  content: unknown,
): Array<{ type: "text"; text: string }> =>
  typeof content === "string" && content.trim().length > 0
    ? [{ type: "text", text: content.trim() }]
    : [];

export const extractWebSearchProviderErrorMessage = async (
  response: Response,
): Promise<string | undefined> => {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) {
      return text;
    }

    if (typeof parsed.detail === "string") {
      return parsed.detail;
    }
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return text;
  }

  return text;
};
