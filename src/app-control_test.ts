import { assertEquals, assertExists } from "@std/assert";
import { DEFAULT_SEARCH_CONFIG } from "./data-plane/tools/web-search/search-config.ts";
import {
  copilotModels,
  jsonResponse,
  requestApp,
  setupAppTest,
  withMockedFetch,
} from "./test-helpers.ts";

Deno.test("admin key is limited to control plane routes", async () => {
  const { adminKey } = await setupAppTest();

  const exportResponse = await requestApp("/api/export", {
    headers: { "x-api-key": adminKey },
  });
  assertEquals(exportResponse.status, 200);

  const modelsResponse = await requestApp("/v1/models", {
    headers: { "x-api-key": adminKey },
  });
  assertEquals(modelsResponse.status, 403);
  assertEquals(await modelsResponse.json(), {
    error: "This key is for dashboard only. Create an API key for API access.",
  });
});

Deno.test("admin key can access playground-approved data plane routes with x-models-playground", async () => {
  const { adminKey } = await setupAppTest();

  await withMockedFetch(async (request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }

    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }

    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([{ id: "claude-test" }]));
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/models", {
      headers: {
        "x-api-key": adminKey,
        "x-models-playground": "1",
      },
    });

    assertEquals(response.status, 200);
    assertEquals((await response.json()).data[0].id, "claude-test");
  });
});

Deno.test("API key users only see their own key in /api/keys", async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: "key_other",
    name: "Other key",
    key: "raw_other_key",
    createdAt: "2026-03-15T00:00:00.000Z",
  });

  const response = await requestApp("/api/keys", {
    headers: { "x-api-key": apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 1);
  assertEquals(body[0].id, apiKey.id);
  assertEquals(body[0].key, apiKey.key);
});

Deno.test("API key users cannot call admin-only key mutation routes", async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp(`/api/keys/${apiKey.id}/rotate`, {
    method: "POST",
    headers: { "x-api-key": apiKey.key },
  });

  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: "Dashboard key required" });
});

Deno.test("API key users cannot mutate /api/search-config routes", async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp("/api/search-config", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey.key,
    },
    body: JSON.stringify(DEFAULT_SEARCH_CONFIG),
  });

  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: "Dashboard key required" });
});

Deno.test("/api/token-usage is visible to any authenticated user and includes all keys", async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: "key_other",
    name: "Other key",
    key: "raw_other_key",
    createdAt: "2026-03-15T00:00:00.000Z",
  });
  await repo.usage.set({
    keyId: apiKey.id,
    model: "claude-sonnet-4",
    hour: "2026-03-15T10",
    requests: 2,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 4,
    cacheCreationTokens: 1,
  });
  await repo.usage.set({
    keyId: "key_other",
    model: "gpt-5",
    hour: "2026-03-15T11",
    requests: 1,
    inputTokens: 20,
    outputTokens: 8,
    cacheReadTokens: 6,
    cacheCreationTokens: 2,
  });

  const response = await requestApp(
    "/api/token-usage?start=2026-03-15T00&end=2026-03-16T00",
    {
      headers: { "x-api-key": apiKey.key },
    },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 2);
  assertEquals(body[0].keyName, "Primary key");
  assertEquals(body[1].keyName, "Other key");
  const ownRecord = body.find((record: { keyId: string }) =>
    record.keyId === apiKey.id
  );
  const otherRecord = body.find((record: { keyId: string }) =>
    record.keyId === "key_other"
  );
  assertExists(ownRecord);
  assertExists(otherRecord);
  assertEquals(ownRecord.cacheReadTokens, 4);
  assertEquals(ownRecord.cacheCreationTokens, 1);
  assertEquals(otherRecord.cacheReadTokens, 6);
  assertEquals(otherRecord.cacheCreationTokens, 2);
});
