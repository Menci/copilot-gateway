import { assertEquals } from "@std/assert";
import { jsonResponse, withMockedFetch } from "../../../test-helpers.ts";
import { createMicrosoftGroundingWebSearchProvider } from "./microsoft-grounding.ts";

Deno.test(
  "createMicrosoftGroundingWebSearchProvider calls v3 search/web with passage content",
  async () => {
    let request: Request | undefined;

    await withMockedFetch((incoming) => {
      request = incoming;
      return jsonResponse({
        webResults: [{
          title: "React",
          url: "https://react.dev",
          content: "Official React documentation",
          lastUpdatedAt: "2026-04-01T00:00:00Z",
        }],
      });
    }, async () => {
      const provider = createMicrosoftGroundingWebSearchProvider("ms-test");
      const result = await provider({
        query: "React documentation",
        allowedDomains: ["react.dev", "example.com OR site:evil.com"],
        blockedDomains: ["example.com", "bad.com test"],
        userLocation: {
          country: "GB",
          region: "WA",
        },
      });

      assertEquals(request?.url, "https://api.microsoft.ai/v3/search/web");
      assertEquals(request?.headers.get("x-apikey"), "ms-test");
      const body = JSON.parse(await request!.text());
      assertEquals(
        body.query,
        "React documentation site:react.dev -site:example.com",
      );
      assertEquals(body.count, 10);
      assertEquals(body.contentFormat, "passage");
      assertEquals(body.region, "GB");
      assertEquals(result.type, "ok");
      if (result.type !== "ok") {
        throw new Error("expected successful Microsoft Grounding result");
      }
      assertEquals(result.results[0].pageAge, "2026-04-01T00:00:00Z");
    });
  },
);

Deno.test(
  "createMicrosoftGroundingWebSearchProvider rejects blank and overlong queries before fetch",
  async () => {
    let called = false;

    await withMockedFetch(() => {
      called = true;
      return jsonResponse({ webResults: [] });
    }, async () => {
      const provider = createMicrosoftGroundingWebSearchProvider("ms-test");

      assertEquals(await provider({ query: "   " }), {
        type: "error",
        errorCode: "invalid_tool_input",
        message: "Search query must not be empty.",
      });

      assertEquals(await provider({ query: "x".repeat(1001) }), {
        type: "error",
        errorCode: "query_too_long",
        message: "Search query must be at most 1000 characters.",
      });
    });

    assertEquals(called, false);
  },
);

Deno.test(
  "createMicrosoftGroundingWebSearchProvider maps 429 to too_many_requests",
  async () => {
    await withMockedFetch(
      () => jsonResponse({ message: "rate limited" }, 429),
      async () => {
        const provider = createMicrosoftGroundingWebSearchProvider("ms-test");
        assertEquals(await provider({ query: "React documentation" }), {
          type: "error",
          errorCode: "too_many_requests",
          message: "rate limited",
        });
      },
    );
  },
);

Deno.test(
  "createMicrosoftGroundingWebSearchProvider maps 413 to request_too_large",
  async () => {
    await withMockedFetch(
      () => jsonResponse({ message: "too large" }, 413),
      async () => {
        const provider = createMicrosoftGroundingWebSearchProvider("ms-test");
        assertEquals(await provider({ query: "React documentation" }), {
          type: "error",
          errorCode: "request_too_large",
          message: "too large",
        });
      },
    );
  },
);
