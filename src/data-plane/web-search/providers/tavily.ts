import {
  DEFAULT_WEB_SEARCH_RESULT_COUNT,
  type WebSearchProviderRequest,
  type WebSearchProviderResult,
} from "../types.ts";
import { isRecord } from "../../../lib/type-guards.ts";
import {
  extractWebSearchProviderErrorMessage,
  toWebSearchTextBlocks,
  validateWebSearchQuery,
} from "./shared.ts";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

const normalizeDomains = (domains?: string[]): string[] | undefined => {
  const normalized = domains?.map((domain) => domain.trim()).filter(Boolean);
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const normalizeResult = (
  value: unknown,
):
  | Extract<WebSearchProviderResult, { type: "ok" }>["results"][number]
  | null => {
  if (
    !isRecord(value) || typeof value.title !== "string" ||
    typeof value.url !== "string"
  ) {
    return null;
  }

  return {
    source: value.url,
    title: value.title,
    pageAge: typeof value.published_date === "string" &&
        value.published_date.trim().length > 0
      ? value.published_date
      : undefined,
    content: toWebSearchTextBlocks(value.content),
  };
};

export const createTavilyWebSearchProvider = (
  apiKey: string,
) =>
async (
  request: WebSearchProviderRequest,
): Promise<WebSearchProviderResult> => {
  const validatedQuery = validateWebSearchQuery(request.query);
  if (validatedQuery.type === "error") {
    return validatedQuery.result;
  }

  const includeDomains = normalizeDomains(request.allowedDomains);
  const excludeDomains = normalizeDomains(request.blockedDomains);
  const body: Record<string, unknown> = {
    query: validatedQuery.query,
    max_results: DEFAULT_WEB_SEARCH_RESULT_COUNT,
  };
  if (
    typeof request.userLocation?.country === "string" &&
    request.userLocation.country.trim().length > 0
  ) {
    body.country = request.userLocation.country.trim();
  }
  if (includeDomains) {
    body.include_domains = includeDomains;
  }
  if (excludeDomains) {
    body.exclude_domains = excludeDomains;
  }

  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const message = await extractWebSearchProviderErrorMessage(response);
      if (response.status === 429) {
        return {
          type: "error",
          errorCode: "too_many_requests",
          message: message ?? "Tavily rate limited the request.",
        };
      }

      if (response.status === 400) {
        return {
          type: "error",
          errorCode: "invalid_tool_input",
          message: message ?? "Tavily rejected the search query.",
        };
      }

      if (response.status === 413) {
        return {
          type: "error",
          errorCode: "request_too_large",
          message: message ?? "Tavily rejected the request as too large.",
        };
      }

      return {
        type: "error",
        errorCode: "unavailable",
        message: message ?? "Tavily search failed.",
      };
    }

    const payload = await response.json();
    const results = isRecord(payload) && Array.isArray(payload.results)
      ? payload.results
        .map(normalizeResult)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      : [];

    return {
      type: "ok",
      results: results.slice(0, DEFAULT_WEB_SEARCH_RESULT_COUNT),
    };
  } catch (error) {
    return {
      type: "error",
      errorCode: "unavailable",
      message: error instanceof Error ? error.message : "Tavily search failed.",
    };
  }
};
