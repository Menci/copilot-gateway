import type { SearchConfig } from "../../data-plane/web-search/types.ts";

export interface DashboardSearchConfigDraft {
  provider: SearchConfig["provider"];
  tavilyApiKey: string;
  microsoftGroundingApiKey: string;
}

export const draftFromSearchConfig = (
  config: SearchConfig,
): DashboardSearchConfigDraft => ({
  provider: config.provider,
  tavilyApiKey: config.tavily.apiKey,
  microsoftGroundingApiKey: config.microsoftGrounding.apiKey,
});

export const activeCredentialValue = (
  draft: DashboardSearchConfigDraft,
): string =>
  draft.provider === "tavily"
    ? draft.tavilyApiKey
    : draft.provider === "microsoft-grounding"
    ? draft.microsoftGroundingApiKey
    : "";

export const setActiveCredentialValue = (
  draft: DashboardSearchConfigDraft,
  value: string,
): DashboardSearchConfigDraft =>
  draft.provider === "tavily"
    ? { ...draft, tavilyApiKey: value }
    : draft.provider === "microsoft-grounding"
    ? { ...draft, microsoftGroundingApiKey: value }
    : draft;

export const searchConfigFromDraft = (
  draft: DashboardSearchConfigDraft,
): SearchConfig => ({
  provider: draft.provider,
  tavily: { apiKey: draft.tavilyApiKey },
  microsoftGrounding: { apiKey: draft.microsoftGroundingApiKey },
});
