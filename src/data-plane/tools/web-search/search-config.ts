import { getRepo } from "../../../repo/index.ts";
import { isRecord } from "../../../lib/type-guards.ts";
import type { SearchConfig } from "./types.ts";

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  provider: "disabled",
  tavily: { apiKey: "" },
  microsoftGrounding: { apiKey: "" },
};

export const FIXED_SEARCH_CONFIG_TEST_QUERY = "React documentation";

export const normalizeSearchConfig = (
  input: unknown,
): SearchConfig => {
  const record = isRecord(input) ? input : {};
  const tavily = isRecord(record.tavily) ? record.tavily : {};
  const microsoftGrounding = isRecord(record.microsoftGrounding)
    ? record.microsoftGrounding
    : {};

  return {
    provider: record.provider === "tavily" ||
        record.provider === "microsoft-grounding"
      ? record.provider
      : "disabled",
    tavily: {
      apiKey: typeof tavily.apiKey === "string" ? tavily.apiKey.trim() : "",
    },
    microsoftGrounding: {
      apiKey: typeof microsoftGrounding.apiKey === "string"
        ? microsoftGrounding.apiKey.trim()
        : "",
    },
  };
};

export const loadSearchConfig = async (): Promise<SearchConfig> =>
  normalizeSearchConfig(await getRepo().searchConfig.get());

export const saveSearchConfig = async (
  config: unknown,
): Promise<SearchConfig> => {
  const normalized = normalizeSearchConfig(config);
  await getRepo().searchConfig.save(normalized);
  return normalized;
};
