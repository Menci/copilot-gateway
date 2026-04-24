import { assertEquals } from "@std/assert";
import {
  jsonResponse,
  requestApp,
  setupAppTest,
  withMockedFetch,
} from "../test-helpers.ts";
import { DEFAULT_SEARCH_CONFIG } from "../data-plane/web-search/search-config.ts";

Deno.test("/api/search-config GET returns the default disabled config for admin", async () => {
  const { adminKey } = await setupAppTest();

  const response = await requestApp("/api/search-config", {
    headers: { "x-api-key": adminKey },
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), DEFAULT_SEARCH_CONFIG);
});

Deno.test("/api/search-config PUT persists config and POST /test returns preview", async () => {
  const { adminKey } = await setupAppTest();

  await withMockedFetch((request) => {
    const url = new URL(request.url);
    if (url.hostname === "api.tavily.com") {
      return jsonResponse({
        results: [
          {
            title: "React",
            url: "https://react.dev",
            content: "Official docs",
          },
          {
            title: "React Learn",
            url: "https://react.dev/learn",
            content: "Learn React",
          },
          {
            title: "React API",
            url: "https://react.dev/reference",
            content: "React API reference",
          },
          {
            title: "Extra",
            url: "https://example.com/extra",
            content: "should be trimmed",
          },
        ],
      });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const config = {
      provider: "tavily",
      tavily: { apiKey: "tvly-test" },
      microsoftGrounding: { apiKey: "ms-test" },
    };

    const putResponse = await requestApp("/api/search-config", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-api-key": adminKey },
      body: JSON.stringify(config),
    });
    assertEquals(putResponse.status, 200);

    const testResponse = await requestApp("/api/search-config/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": adminKey },
      body: JSON.stringify(config),
    });

    const body = await testResponse.json();
    assertEquals(testResponse.status, 200);
    assertEquals(body.ok, true);
    assertEquals(body.query, "React documentation");
    assertEquals(body.results.length, 3);
  });
});
