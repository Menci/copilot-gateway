import { assertEquals } from "@std/assert";
import { jsonResponse, withMockedFetch } from "../../../test-helpers.ts";
import { createTavilyWebSearchProvider } from "./tavily.ts";

Deno.test(
  "createTavilyWebSearchProvider sends bearer auth and domain filters",
  async () => {
    let request: Request | undefined;

    await withMockedFetch((incoming) => {
      request = incoming;
      return jsonResponse({
        results: [{
          title: "React",
          url: "https://react.dev",
          content: "Official React documentation",
        }],
      });
    }, async () => {
      const provider = createTavilyWebSearchProvider("tvly-test");
      const result = await provider({
        query: "React documentation",
        allowedDomains: ["react.dev"],
        blockedDomains: ["example.com"],
        userLocation: { country: "US" },
      });

      assertEquals(request?.url, "https://api.tavily.com/search");
      assertEquals(request?.headers.get("authorization"), "Bearer tvly-test");
      const body = JSON.parse(await request!.text());
      assertEquals(body.query, "React documentation");
      assertEquals(body.country, "US");
      assertEquals(body.include_domains, ["react.dev"]);
      assertEquals(body.exclude_domains, ["example.com"]);
      assertEquals(body.max_results, 10);
      assertEquals(result.type, "ok");
      if (result.type !== "ok") {
        throw new Error("expected successful Tavily result");
      }
      assertEquals(result.results[0].source, "https://react.dev");
    });
  },
);

Deno.test(
  "createTavilyWebSearchProvider rejects blank and overlong queries before fetch",
  async () => {
    let called = false;

    await withMockedFetch(() => {
      called = true;
      return jsonResponse({ results: [] });
    }, async () => {
      const provider = createTavilyWebSearchProvider("tvly-test");

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

Deno.test("createTavilyWebSearchProvider maps 429 to too_many_requests", async () => {
  await withMockedFetch(
    () => jsonResponse({ message: "rate limited" }, 429),
    async () => {
      const provider = createTavilyWebSearchProvider("tvly-test");
      assertEquals(await provider({ query: "React documentation" }), {
        type: "error",
        errorCode: "too_many_requests",
        message: "rate limited",
      });
    },
  );
});

Deno.test("createTavilyWebSearchProvider maps 413 to request_too_large", async () => {
  await withMockedFetch(
    () => jsonResponse({ message: "too large" }, 413),
    async () => {
      const provider = createTavilyWebSearchProvider("tvly-test");
      assertEquals(await provider({ query: "React documentation" }), {
        type: "error",
        errorCode: "request_too_large",
        message: "too large",
      });
    },
  );
});
