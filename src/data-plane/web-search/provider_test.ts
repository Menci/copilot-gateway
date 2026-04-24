import { assertEquals } from "@std/assert";
import { jsonResponse, withMockedFetch } from "../../test-helpers.ts";
import {
  resolveConfiguredWebSearchProvider,
  testSearchConfigConnection,
} from "./provider.ts";
import {
  DEFAULT_SEARCH_CONFIG,
  FIXED_SEARCH_CONFIG_TEST_QUERY,
} from "./search-config.ts";

Deno.test(
  "resolveConfiguredWebSearchProvider returns disabled, missing-credential, or enabled",
  () => {
    assertEquals(resolveConfiguredWebSearchProvider(DEFAULT_SEARCH_CONFIG), {
      type: "disabled",
    });

    assertEquals(
      resolveConfiguredWebSearchProvider({
        provider: "tavily",
        tavily: { apiKey: "" },
        microsoftGrounding: { apiKey: "ms-test" },
      }),
      {
        type: "missing-credential",
        provider: "tavily",
      },
    );

    const resolved = resolveConfiguredWebSearchProvider({
      provider: "microsoft-grounding",
      tavily: { apiKey: "tvly-test" },
      microsoftGrounding: { apiKey: "ms-test" },
    });

    assertEquals(resolved.type, "enabled");
    if (resolved.type !== "enabled") {
      throw new Error("expected enabled provider");
    }
    assertEquals(resolved.provider, "microsoft-grounding");
  },
);

Deno.test(
  "testSearchConfigConnection returns structured disabled and missing-credential errors",
  async () => {
    assertEquals(await testSearchConfigConnection(DEFAULT_SEARCH_CONFIG), {
      ok: false,
      provider: "disabled",
      query: FIXED_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: "disabled",
        message: "Search provider is disabled.",
      },
    });

    assertEquals(
      await testSearchConfigConnection({
        provider: "tavily",
        tavily: { apiKey: "" },
        microsoftGrounding: { apiKey: "ms-test" },
      }),
      {
        ok: false,
        provider: "tavily",
        query: FIXED_SEARCH_CONFIG_TEST_QUERY,
        error: {
          code: "missing_credential",
          message: "Missing API key for tavily.",
        },
      },
    );
  },
);

Deno.test(
  "testSearchConfigConnection previews at most three normalized results",
  async () => {
    await withMockedFetch(
      () =>
        jsonResponse({
          results: [
            {
              title: "React A",
              url: "https://react.dev/a",
              content: "A".repeat(400),
              published_date: "2026-04-01T00:00:00Z",
            },
            {
              title: "React B",
              url: "https://react.dev/b",
              content: "Second result",
            },
            {
              title: "React C",
              url: "https://react.dev/c",
              content: "Third result",
            },
            {
              title: "React D",
              url: "https://react.dev/d",
              content: "Fourth result",
            },
          ],
        }),
      async () => {
        const result = await testSearchConfigConnection({
          provider: "tavily",
          tavily: { apiKey: "tvly-test" },
          microsoftGrounding: { apiKey: "ms-test" },
        });

        assertEquals(result.ok, true);
        if (!result.ok) {
          throw new Error("expected a successful preview result");
        }

        assertEquals(result.provider, "tavily");
        assertEquals(result.query, FIXED_SEARCH_CONFIG_TEST_QUERY);
        assertEquals(result.results.length, 3);
        assertEquals(result.results[0].title, "React A");
        assertEquals(result.results[0].url, "https://react.dev/a");
        assertEquals(result.results[0].pageAge, "2026-04-01T00:00:00Z");
        assertEquals(result.results[0].previewText.length, 280);
        assertEquals(result.results[2].title, "React C");
      },
    );
  },
);

Deno.test(
  "testSearchConfigConnection returns no_results when the provider returns no previews",
  async () => {
    await withMockedFetch(
      () => jsonResponse({ results: [] }),
      async () => {
        assertEquals(
          await testSearchConfigConnection({
            provider: "tavily",
            tavily: { apiKey: "tvly-test" },
            microsoftGrounding: { apiKey: "ms-test" },
          }),
          {
            ok: false,
            provider: "tavily",
            query: FIXED_SEARCH_CONFIG_TEST_QUERY,
            error: {
              code: "no_results",
              message: "Search returned no preview results.",
            },
          },
        );
      },
    );
  },
);

Deno.test(
  "testSearchConfigConnection returns preview results for Microsoft Grounding too",
  async () => {
    await withMockedFetch(
      () =>
        jsonResponse({
          webResults: [{
            title: "React on Microsoft Learn",
            url: "https://learn.microsoft.com/react",
            content: "React guidance from Microsoft Learn.",
            lastUpdatedAt: "2026-04-21T00:00:00Z",
          }],
        }),
      async () => {
        const result = await testSearchConfigConnection({
          provider: "microsoft-grounding",
          tavily: { apiKey: "tvly-test" },
          microsoftGrounding: { apiKey: "ms-test" },
        });

        assertEquals(result.ok, true);
        if (!result.ok) {
          throw new Error("expected a successful Microsoft preview result");
        }

        assertEquals(result.provider, "microsoft-grounding");
        assertEquals(result.query, FIXED_SEARCH_CONFIG_TEST_QUERY);
        assertEquals(result.results, [{
          title: "React on Microsoft Learn",
          url: "https://learn.microsoft.com/react",
          pageAge: "2026-04-21T00:00:00Z",
          previewText: "React guidance from Microsoft Learn.",
        }]);
      },
    );
  },
);
