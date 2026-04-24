import { assertEquals } from "@std/assert";
import {
  activeCredentialValue,
  draftFromSearchConfig,
  searchConfigFromDraft,
  setActiveCredentialValue,
} from "./search-config.ts";

Deno.test("dashboard search config draft preserves inactive provider keys when switching", () => {
  const draft = draftFromSearchConfig({
    provider: "tavily",
    tavily: { apiKey: "tvly-test" },
    microsoftGrounding: { apiKey: "ms-test" },
  });

  assertEquals(activeCredentialValue(draft), "tvly-test");

  const switched = { ...draft, provider: "microsoft-grounding" as const };
  assertEquals(activeCredentialValue(switched), "ms-test");

  const updated = setActiveCredentialValue(switched, "ms-updated");
  assertEquals(updated.tavilyApiKey, "tvly-test");
  assertEquals(updated.microsoftGroundingApiKey, "ms-updated");

  assertEquals(searchConfigFromDraft(updated), {
    provider: "microsoft-grounding",
    tavily: { apiKey: "tvly-test" },
    microsoftGrounding: { apiKey: "ms-updated" },
  });
});
