import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { initRepo } from "../repo/mod.ts";
import { InMemoryRepo } from "../repo/memory.ts";
import { exportData, importData } from "./data-transfer.ts";
import type { ApiKey, GitHubAccount, UsageRecord } from "../repo/types.ts";

// ---- Fixtures ----

const KEY_A: ApiKey = {
  id: "key-aaa",
  name: "Alice",
  key: "raw-key-aaa",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-02T00:00:00.000Z",
};

const KEY_B: ApiKey = {
  id: "key-bbb",
  name: "Bob",
  key: "raw-key-bbb",
  createdAt: "2026-02-01T00:00:00.000Z",
};

const ACCOUNT_X: GitHubAccount = {
  token: "ghu_xxxx",
  accountType: "individual",
  user: { id: 100, login: "alice", name: "Alice", avatar_url: "https://example.com/a.png" },
};

const ACCOUNT_Y: GitHubAccount = {
  token: "ghu_yyyy",
  accountType: "enterprise",
  user: { id: 200, login: "bob", name: null, avatar_url: "https://example.com/b.png" },
};

const USAGE_1: UsageRecord = {
  keyId: "key-aaa",
  model: "claude-opus-4.6",
  hour: "2026-01-01T10",
  requests: 5,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const USAGE_2: UsageRecord = {
  keyId: "key-bbb",
  model: "gpt-5.4",
  hour: "2026-01-01T11",
  requests: 3,
  inputTokens: 2000,
  outputTokens: 800,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

// ---- Helpers ----

function setup() {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const app = new Hono();
  app.get("/export", exportData);
  app.post("/import", importData);
  return { repo, app };
}

async function doExport(app: Hono) {
  const resp = await app.request("/export");
  assertEquals(resp.status, 200);
  return await resp.json();
}

// deno-lint-ignore no-explicit-any
async function doImport(app: Hono, mode: string, data: any) {
  const resp = await app.request("/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, data }),
  });
  return { status: resp.status, body: await resp.json() };
}

// ---- Tests: export structure ----

Deno.test("export — empty database returns correct structure", async () => {
  const { app } = setup();
  const result = await doExport(app);

  assertEquals(result.version, 1);
  assertEquals(typeof result.exportedAt, "string");
  assertEquals(Array.isArray(result.data.apiKeys), true);
  assertEquals(result.data.apiKeys.length, 0);
  assertEquals(Array.isArray(result.data.githubAccounts), true);
  assertEquals(result.data.githubAccounts.length, 0);
  assertEquals(result.data.activeGithubAccountId, null);
  assertEquals(Array.isArray(result.data.usage), true);
  assertEquals(result.data.usage.length, 0);
});

Deno.test("export — contains all stored data", async () => {
  const { app, repo } = setup();

  await repo.apiKeys.save(KEY_A);
  await repo.apiKeys.save(KEY_B);
  await repo.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);
  await repo.github.saveAccount(ACCOUNT_Y.user.id, ACCOUNT_Y);
  await repo.github.setActiveId(200);
  await repo.usage.set(USAGE_1);
  await repo.usage.set(USAGE_2);

  const result = await doExport(app);

  assertEquals(result.data.apiKeys.length, 2);
  assertEquals(result.data.githubAccounts.length, 2);
  assertEquals(result.data.activeGithubAccountId, 200);
  assertEquals(result.data.usage.length, 2);
});

Deno.test("export — apiKeys contain all fields", async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);

  const result = await doExport(app);
  const key = result.data.apiKeys[0];

  assertEquals(key.id, KEY_A.id);
  assertEquals(key.name, KEY_A.name);
  assertEquals(key.key, KEY_A.key);
  assertEquals(key.createdAt, KEY_A.createdAt);
  assertEquals(key.lastUsedAt, KEY_A.lastUsedAt);
});

Deno.test("export — apiKey without lastUsedAt omits or nulls it", async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_B); // KEY_B has no lastUsedAt

  const result = await doExport(app);
  const key = result.data.apiKeys[0];

  assertEquals(key.id, KEY_B.id);
  // lastUsedAt should be absent or null/undefined
  assertEquals(key.lastUsedAt == null, true);
});

Deno.test("export — githubAccounts contain all fields", async () => {
  const { app, repo } = setup();
  await repo.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);

  const result = await doExport(app);
  const account = result.data.githubAccounts[0];

  assertEquals(account.token, ACCOUNT_X.token);
  assertEquals(account.accountType, ACCOUNT_X.accountType);
  assertEquals(account.user.id, ACCOUNT_X.user.id);
  assertEquals(account.user.login, ACCOUNT_X.user.login);
  assertEquals(account.user.name, ACCOUNT_X.user.name);
  assertEquals(account.user.avatar_url, ACCOUNT_X.user.avatar_url);
});

Deno.test("export — githubAccount with null name", async () => {
  const { app, repo } = setup();
  await repo.github.saveAccount(ACCOUNT_Y.user.id, ACCOUNT_Y);

  const result = await doExport(app);
  assertEquals(result.data.githubAccounts[0].user.name, null);
});

Deno.test("export — usage records contain all fields", async () => {
  const { app, repo } = setup();
  await repo.usage.set(USAGE_1);

  const result = await doExport(app);
  const u = result.data.usage[0];

  assertEquals(u.keyId, USAGE_1.keyId);
  assertEquals(u.model, USAGE_1.model);
  assertEquals(u.hour, USAGE_1.hour);
  assertEquals(u.requests, USAGE_1.requests);
  assertEquals(u.inputTokens, USAGE_1.inputTokens);
  assertEquals(u.outputTokens, USAGE_1.outputTokens);
});

// ---- Tests: round-trip (import → export) ----

Deno.test("round-trip — replace import then export yields equivalent data", async () => {
  const { app } = setup();

  const original = {
    apiKeys: [KEY_A, KEY_B],
    githubAccounts: [ACCOUNT_X, ACCOUNT_Y],
    activeGithubAccountId: 100,
    usage: [USAGE_1, USAGE_2],
  };

  const { status, body } = await doImport(app, "replace", original);
  assertEquals(status, 200);
  assertEquals(body.ok, true);
  assertEquals(body.imported, { apiKeys: 2, githubAccounts: 2, usage: 2 });

  const exported = await doExport(app);

  // Sort for stable comparison
  const sortById = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const sortByUserId = (a: GitHubAccount, b: GitHubAccount) => a.user.id - b.user.id;
  const sortByUsage = (a: UsageRecord, b: UsageRecord) =>
    a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId);

  exported.data.apiKeys.sort(sortById);
  exported.data.githubAccounts.sort(sortByUserId);
  exported.data.usage.sort(sortByUsage);

  const expected = { ...original };
  expected.apiKeys = [...original.apiKeys].sort(sortById);
  expected.githubAccounts = [...original.githubAccounts].sort(sortByUserId);
  expected.usage = [...original.usage].sort(sortByUsage);

  assertEquals(exported.data.apiKeys, expected.apiKeys);
  assertEquals(exported.data.githubAccounts, expected.githubAccounts);
  assertEquals(exported.data.activeGithubAccountId, expected.activeGithubAccountId);
  assertEquals(exported.data.usage, expected.usage);
});

Deno.test("round-trip — merge import then export contains both old and new data", async () => {
  const { app, repo } = setup();

  // Pre-existing data
  await repo.apiKeys.save(KEY_A);
  await repo.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);
  await repo.github.setActiveId(100);
  await repo.usage.set(USAGE_1);

  // Merge new data
  const newData = {
    apiKeys: [KEY_B],
    githubAccounts: [ACCOUNT_Y],
    activeGithubAccountId: 200,
    usage: [USAGE_2],
  };

  const { status } = await doImport(app, "merge", newData);
  assertEquals(status, 200);

  const exported = await doExport(app);

  assertEquals(exported.data.apiKeys.length, 2);
  assertEquals(exported.data.githubAccounts.length, 2);
  assertEquals(exported.data.usage.length, 2);
  // Merge preserves existing activeId
  assertEquals(exported.data.activeGithubAccountId, 100);
});

Deno.test("round-trip — double import with replace is idempotent", async () => {
  const { app } = setup();

  const data = {
    apiKeys: [KEY_A],
    githubAccounts: [ACCOUNT_X],
    activeGithubAccountId: 100,
    usage: [USAGE_1],
  };

  await doImport(app, "replace", data);
  await doImport(app, "replace", data);

  const exported = await doExport(app);
  assertEquals(exported.data.apiKeys.length, 1);
  assertEquals(exported.data.githubAccounts.length, 1);
  assertEquals(exported.data.usage.length, 1);
});

Deno.test("round-trip — export from A, import into B, export from B matches A", async () => {
  // Simulate cross-platform migration: Deno → CF
  const repoA = new InMemoryRepo();
  initRepo(repoA);
  const appA = new Hono();
  appA.get("/export", exportData);
  appA.post("/import", importData);

  await repoA.apiKeys.save(KEY_A);
  await repoA.apiKeys.save(KEY_B);
  await repoA.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);
  await repoA.github.setActiveId(100);
  await repoA.usage.set(USAGE_1);
  await repoA.usage.set(USAGE_2);

  const exportA = await doExport(appA);

  // Platform B — fresh repo
  const repoB = new InMemoryRepo();
  initRepo(repoB);
  const appB = new Hono();
  appB.get("/export", exportData);
  appB.post("/import", importData);

  await doImport(appB, "replace", exportA.data);
  const exportB = await doExport(appB);

  // Compare data (ignoring exportedAt timestamp)
  const sortById = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const sortByUserId = (a: GitHubAccount, b: GitHubAccount) => a.user.id - b.user.id;
  const sortByUsage = (a: UsageRecord, b: UsageRecord) =>
    a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId);

  exportA.data.apiKeys.sort(sortById);
  exportA.data.githubAccounts.sort(sortByUserId);
  exportA.data.usage.sort(sortByUsage);
  exportB.data.apiKeys.sort(sortById);
  exportB.data.githubAccounts.sort(sortByUserId);
  exportB.data.usage.sort(sortByUsage);

  assertEquals(exportB.data.apiKeys, exportA.data.apiKeys);
  assertEquals(exportB.data.githubAccounts, exportA.data.githubAccounts);
  assertEquals(exportB.data.activeGithubAccountId, exportA.data.activeGithubAccountId);
  assertEquals(exportB.data.usage, exportA.data.usage);
});

// ---- Tests: import modes ----

Deno.test("import replace — clears existing data", async () => {
  const { app, repo } = setup();

  await repo.apiKeys.save(KEY_A);
  await repo.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);
  await repo.github.setActiveId(100);
  await repo.usage.set(USAGE_1);

  // Replace with only KEY_B
  await doImport(app, "replace", {
    apiKeys: [KEY_B],
    githubAccounts: [],
    activeGithubAccountId: null,
    usage: [],
  });

  const exported = await doExport(app);
  assertEquals(exported.data.apiKeys.length, 1);
  assertEquals(exported.data.apiKeys[0].id, KEY_B.id);
  assertEquals(exported.data.githubAccounts.length, 0);
  assertEquals(exported.data.activeGithubAccountId, null);
  assertEquals(exported.data.usage.length, 0);
});

Deno.test("import merge — preserves existing active ID", async () => {
  const { app, repo } = setup();

  await repo.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);
  await repo.github.setActiveId(100);

  await doImport(app, "merge", {
    githubAccounts: [ACCOUNT_Y],
    activeGithubAccountId: 200,
  });

  const exported = await doExport(app);
  // Active ID should remain 100 (existing), not overwritten to 200
  assertEquals(exported.data.activeGithubAccountId, 100);
});

Deno.test("import merge — sets active ID when currently unset", async () => {
  const { app } = setup();

  await doImport(app, "merge", {
    githubAccounts: [ACCOUNT_X],
    activeGithubAccountId: 100,
  });

  const exported = await doExport(app);
  assertEquals(exported.data.activeGithubAccountId, 100);
});

Deno.test("import merge — upserts existing records by key", async () => {
  const { app, repo } = setup();

  // Pre-existing KEY_A with old name
  await repo.apiKeys.save({ ...KEY_A, name: "OldName" });

  // Merge with KEY_A (new name) + KEY_B
  await doImport(app, "merge", {
    apiKeys: [KEY_A, KEY_B],
  });

  const exported = await doExport(app);
  assertEquals(exported.data.apiKeys.length, 2);
  const updatedA = exported.data.apiKeys.find((k: ApiKey) => k.id === KEY_A.id);
  assertEquals(updatedA.name, "Alice"); // updated to imported value
});

Deno.test("import merge — usage set overwrites matching records", async () => {
  const { app, repo } = setup();

  // Existing usage
  await repo.usage.set({ ...USAGE_1, requests: 10, inputTokens: 9999, outputTokens: 8888 });

  // Merge with USAGE_1 (different values)
  await doImport(app, "merge", { usage: [USAGE_1] });

  const exported = await doExport(app);
  assertEquals(exported.data.usage.length, 1);
  assertEquals(exported.data.usage[0].requests, USAGE_1.requests); // 5, not 10
  assertEquals(exported.data.usage[0].inputTokens, USAGE_1.inputTokens);
});

// ---- Tests: validation ----

Deno.test("import — rejects invalid mode", async () => {
  const { app } = setup();
  const { status, body } = await doImport(app, "invalid", { apiKeys: [] });
  assertEquals(status, 400);
  assertEquals(body.error, "mode must be 'merge' or 'replace'");
});

Deno.test("import — rejects missing data", async () => {
  const { app } = setup();
  const resp = await app.request("/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "merge" }),
  });
  assertEquals(resp.status, 400);
  const body = await resp.json();
  assertEquals(body.error, "data is required");
});

Deno.test("import — handles missing optional arrays gracefully", async () => {
  const { app } = setup();
  // data object with no arrays
  const { status, body } = await doImport(app, "replace", {});
  assertEquals(status, 200);
  assertEquals(body.ok, true);
  assertEquals(body.imported, { apiKeys: 0, githubAccounts: 0, usage: 0 });
});
