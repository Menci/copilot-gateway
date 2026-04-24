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

const MICROSOFT_GROUNDING_SEARCH_URL = "https://api.microsoft.ai/v3/search/web";
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/i;

const normalizeDomains = (domains?: string[]): string[] =>
  domains?.map((domain) => domain.trim()).filter((domain) =>
    DOMAIN_PATTERN.test(domain)
  ) ?? [];

const toMicrosoftQuery = (request: WebSearchProviderRequest, query: string) => {
  const parts = [
    query,
    ...normalizeDomains(request.allowedDomains).map((domain) =>
      `site:${domain}`
    ),
    ...normalizeDomains(request.blockedDomains).map((domain) =>
      `-site:${domain}`
    ),
  ];

  // Microsoft Grounding does not expose dedicated allow/block-domain fields in
  // our integration surface, so domain policy is forwarded as query operators.
  // This is best-effort biasing, not a strict filtering guarantee.
  return parts.join(" ");
};

const toMicrosoftRegion = (
  userLocation: WebSearchProviderRequest["userLocation"],
): string | undefined => {
  const candidate = userLocation?.country?.trim();
  return candidate && /^[a-z]{2}$/i.test(candidate)
    ? candidate.toUpperCase()
    : undefined;
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

  const pageAge = typeof value.lastUpdatedAt === "string" &&
      value.lastUpdatedAt.trim().length > 0
    ? value.lastUpdatedAt
    : typeof value.crawledAt === "string" && value.crawledAt.trim().length > 0
    ? value.crawledAt
    : undefined;

  return {
    source: value.url,
    title: value.title,
    pageAge,
    content: toWebSearchTextBlocks(value.content),
  };
};

export const createMicrosoftGroundingWebSearchProvider = (
  apiKey: string,
) =>
async (
  request: WebSearchProviderRequest,
): Promise<WebSearchProviderResult> => {
  const validatedQuery = validateWebSearchQuery(request.query);
  if (validatedQuery.type === "error") {
    return validatedQuery.result;
  }

  const body: Record<string, unknown> = {
    query: toMicrosoftQuery(request, validatedQuery.query),
    count: DEFAULT_WEB_SEARCH_RESULT_COUNT,
    contentFormat: "passage",
  };
  const region = toMicrosoftRegion(request.userLocation);
  if (region) {
    body.region = region;
  }

  try {
    const response = await fetch(MICROSOFT_GROUNDING_SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-apikey": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const message = await extractWebSearchProviderErrorMessage(response);
      if (response.status === 429) {
        return {
          type: "error",
          errorCode: "too_many_requests",
          message: message ?? "Microsoft Grounding rate limited the request.",
        };
      }

      if (response.status === 400) {
        return {
          type: "error",
          errorCode: "invalid_tool_input",
          message: message ?? "Microsoft Grounding rejected the search query.",
        };
      }

      if (response.status === 413) {
        return {
          type: "error",
          errorCode: "request_too_large",
          message: message ??
            "Microsoft Grounding rejected the request as too large.",
        };
      }

      return {
        type: "error",
        errorCode: "unavailable",
        message: message ?? "Microsoft Grounding search failed.",
      };
    }

    const payload = await response.json();
    const results = isRecord(payload) && Array.isArray(payload.webResults)
      ? payload.webResults
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
      message: error instanceof Error
        ? error.message
        : "Microsoft Grounding search failed.",
    };
  }
};
