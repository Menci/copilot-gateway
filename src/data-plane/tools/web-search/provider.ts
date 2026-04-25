import { FIXED_SEARCH_CONFIG_TEST_QUERY } from "./search-config.ts";
import type {
  SearchConfig,
  WebSearchPreviewResult,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from "./types.ts";
import { createMicrosoftGroundingWebSearchProvider } from "./providers/microsoft-grounding.ts";
import { createTavilyWebSearchProvider } from "./providers/tavily.ts";

export type WebSearchProvider = (
  request: WebSearchProviderRequest,
) => Promise<WebSearchProviderResult>;

export type ConfiguredWebSearchProvider =
  | { type: "disabled" }
  | { type: "missing-credential"; provider: "tavily" | "microsoft-grounding" }
  | {
    type: "enabled";
    provider: "tavily" | "microsoft-grounding";
    search: WebSearchProvider;
  };

export type SearchConfigConnectionTestResult =
  | {
    ok: true;
    provider: SearchConfig["provider"];
    query: string;
    results: WebSearchPreviewResult[];
  }
  | {
    ok: false;
    provider: SearchConfig["provider"];
    query: string;
    error: { code: string; message: string };
  };

const toPreviewText = (
  content: Array<{ type: "text"; text: string }>,
): string => content.map((block) => block.text).join("\n").slice(0, 280);

export const resolveConfiguredWebSearchProvider = (
  config: SearchConfig,
): ConfiguredWebSearchProvider => {
  if (config.provider === "disabled") {
    return { type: "disabled" };
  }

  if (config.provider === "tavily") {
    return config.tavily.apiKey
      ? {
        type: "enabled",
        provider: "tavily",
        search: createTavilyWebSearchProvider(config.tavily.apiKey),
      }
      : { type: "missing-credential", provider: "tavily" };
  }

  return config.microsoftGrounding.apiKey
    ? {
      type: "enabled",
      provider: "microsoft-grounding",
      search: createMicrosoftGroundingWebSearchProvider(
        config.microsoftGrounding.apiKey,
      ),
    }
    : { type: "missing-credential", provider: "microsoft-grounding" };
};

export const testSearchConfigConnection = async (
  config: SearchConfig,
): Promise<SearchConfigConnectionTestResult> => {
  const resolved = resolveConfiguredWebSearchProvider(config);

  if (resolved.type === "disabled") {
    return {
      ok: false,
      provider: "disabled",
      query: FIXED_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: "disabled",
        message: "Search provider is disabled.",
      },
    };
  }

  if (resolved.type === "missing-credential") {
    return {
      ok: false,
      provider: resolved.provider,
      query: FIXED_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: "missing_credential",
        message: `Missing API key for ${resolved.provider}.`,
      },
    };
  }

  const result = await resolved.search({
    query: FIXED_SEARCH_CONFIG_TEST_QUERY,
  });

  if (result.type === "error") {
    return {
      ok: false,
      provider: resolved.provider,
      query: FIXED_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: result.errorCode,
        message: result.message ?? "Search test failed.",
      },
    };
  }

  const previews = result.results.slice(0, 3).map((entry) => ({
    title: entry.title,
    url: entry.source,
    pageAge: entry.pageAge,
    previewText: toPreviewText(entry.content),
  }));

  if (previews.length === 0) {
    return {
      ok: false,
      provider: resolved.provider,
      query: FIXED_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: "no_results",
        message: "Search returned no preview results.",
      },
    };
  }

  return {
    ok: true,
    provider: resolved.provider,
    query: FIXED_SEARCH_CONFIG_TEST_QUERY,
    results: previews,
  };
};
