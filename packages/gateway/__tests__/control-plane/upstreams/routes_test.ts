import { test } from 'vitest';

import { blueprintUpstreamRecord, upstreamRecordToFullJson } from '../../../src/control-plane/upstreams/serialize.ts';
import { MODEL_LISTING_FAILURE_CODE } from '../../../src/data-plane/models/shared.ts';
import { MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import type { UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

type JsonObject = Record<string, any>;

// Every action endpoint takes a `record` envelope. Two build paths: a blueprint-shaped envelope for
// create-flow tests (`record.id === ''`), and a full-record envelope for
// edit-flow tests (`record.id !== ''`) built from a repo-fetched row.
const envelopeFromRecord = (record: UpstreamRecord): Record<string, unknown> => upstreamRecordToFullJson(record) as unknown as Record<string, unknown>;

const blueprintEnvelope = (kind: UpstreamProviderKind, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...blueprintUpstreamRecord(kind),
  proxy_fallback_list: MOCKED_FETCH_EGRESS,
  ...overrides,
});

const customConfig = {
  baseUrl: 'https://custom.example.com',
  authStyle: 'bearer',
  ingressHeadersRules: [],
  apiKey: 'sk-test',
  endpoints: { openaiChatCompletions: {} },
};

const azureConfig = {
  endpoint: 'https://example.openai.azure.com',
  apiKey: 'az-secret',
  models: [
    {
      upstreamModelId: 'gpt-prod',
      publicModelId: 'gpt-public',
      endpoints: { openaiChatCompletions: {}, openaiResponses: {} },
    },
  ],
};

const copilotConfig = {
  githubHost: 'github.com',
  githubToken: 'ghu_secret',
  user: {
    id: 12345,
    login: 'octo',
    name: null,
    avatar_url: 'https://example.com/octo.png',
  },
};

const createBody = (overrides: Record<string, unknown> = {}) => ({
  kind: 'custom',
  name: 'Test custom upstream',
  hue: 210,
  config: customConfig,
  flag_overrides: {},
  proxy_fallback_list: MOCKED_FETCH_EGRESS,
  ...overrides,
});

const authed = (adminSession: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('POST /api/upstreams creates custom upstreams and redacts bearer tokens', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({
    config: {
      ...customConfig,
      ingressHeadersRules: [
        { key: 'X-Request-ID', value: null },
        { key: 'X-Empty', value: '' },
        { key: 'X-Route', value: 'configured' },
      ],
    },
    flag_overrides: { 'vendor-kimi': true },
  })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.kind, 'custom');
  assertEquals(created.config.apiKey, undefined);
  assertEquals(created.config.apiKeySet, true);
  assertEquals(created.config.baseUrl, 'https://custom.example.com');
  assertEquals(created.config.ingressHeadersRules, [
    { key: 'x-request-id', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'configured' },
  ]);
  assertEquals(created.flag_overrides, { 'vendor-kimi': true });

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).apiKey, 'sk-test');
  assertEquals((stored?.config as Record<string, unknown>).ingressHeadersRules, created.config.ingressHeadersRules);

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  const items = (await list.json()) as JsonObject[];
  assertEquals(items[0].config.apiKey, undefined);
});

// `openaiCompletions` must survive request validation as a complete endpoint map;
// stripping it would make this otherwise valid model fail provider validation.
test('POST /api/upstreams accepts a custom model whose only endpoint is /completions', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'none',
      ingressHeadersRules: [],
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{ upstreamModelId: 'davinci-002', endpoints: { openaiCompletions: {} } }],
    },
  })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.config.models[0].endpoints, { openaiCompletions: {} });
});

test('POST /api/upstreams validates Azure models and redacts API keys', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const invalid = await requestApp('/api/upstreams', authed(adminSession, createBody({ kind: 'azure', config: { ...azureConfig, models: [] } })));
  assertEquals(invalid.status, 400);
  const invalidBody = (await invalid.json()) as { error?: string };
  assertEquals(invalidBody.error?.includes('models must be a non-empty array'), true);

  const createdResp = await requestApp('/api/upstreams', authed(adminSession, createBody({ kind: 'azure', name: 'Azure', config: azureConfig })));
  assertEquals(createdResp.status, 201);
  const created = (await createdResp.json()) as JsonObject;
  assertEquals(created.kind, 'azure');
  assertEquals(created.config.apiKey, undefined);
  assertEquals(created.config.apiKeySet, true);
  assertEquals(created.config.endpoint, 'https://example.openai.azure.com');
  assertEquals(created.config.models[0].upstreamModelId, 'gpt-prod');
});

test('POST /api/upstreams creates Copilot upstream rows with redacted GitHub tokens', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Stub every outbound request: the post-save warm tries to mint a Copilot
  // token + fetch the model catalog, neither of which the test cares about.
  // 403 is the terminal status the Copilot auth retry loop short-circuits on,
  // so the warm fails fast instead of burning ~7s of exponential backoff.
  const created = await withMockedFetch(
    () => jsonResponse({ error: 'forbidden' }, 403),
    async () => {
      const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({ kind: 'copilot', name: 'Copilot', config: copilotConfig })));
      assertEquals(resp.status, 201);
      const body = (await resp.json()) as JsonObject;
      return body;
    },
  );
  assertEquals(created.kind, 'copilot');
  assertEquals(created.config.githubToken, undefined);
  assertEquals(created.config.githubTokenSet, true);
  assertEquals(created.config.user.id, 12345);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).githubToken, 'ghu_secret');
});

// --- create-time state assert (OAuth-kind rejection surface) ---
//
// createUpstream runs each kind's state reader against body.state, so a
// caller who bypasses the exchange helpers can't slip a malformed shape
// past the row builder. Copilot's null blueprint passes; codex and
// claude-code blueprints carry `{accounts: []}` and their asserters
// reject null on purpose.

test('POST /api/upstreams rejects a codex create with null state', async () => {
  const { adminSession } = await setupAppTest();

  // Two-step setup: exchange returns a valid config+state patch, then we
  // POST /api/upstreams with the config intact but a null state to prove
  // the create-time state reader rejects it (before the state-hardening
  // fix a client bypassing the exchange could persist this).
  const exchange = await requestApp('/api/upstreams/codex/oauth/exchange', authed(adminSession, {
    record: blueprintEnvelope('codex'),
    auth_json: codexAuthJsonImport().auth_json,
  }));
  assertEquals(exchange.status, 200);
  const { patch } = (await exchange.json()) as { patch: { config: unknown; state: unknown } };

  const resp = await requestApp('/api/upstreams', authed(adminSession, {
    kind: 'codex',
    name: 'Codex',
    hue: 210,
    config: patch.config,
    state: null,
    flag_overrides: {},
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('invalid state for codex'), true);
});

test('POST /api/upstreams rejects a claude-code create with null state', async () => {
  const { adminSession } = await setupAppTest();

  const exchange = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    () => requestApp('/api/upstreams/claude-code/oauth/exchange', authed(adminSession, {
      record: blueprintEnvelope('claude-code'),
      credentials_json: claudeCodeCredentialsJson(),
    })),
  );
  assertEquals(exchange.status, 200);
  const { patch } = (await exchange.json()) as { patch: { config: unknown; state: unknown } };

  const resp = await requestApp('/api/upstreams', authed(adminSession, {
    kind: 'claude-code',
    name: 'Claude Code',
    hue: 210,
    config: patch.config,
    state: null,
    flag_overrides: {},
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('invalid state for claude-code'), true);
});

test('POST /api/upstreams rejects a copilot create with malformed copilotToken', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({
    kind: 'copilot',
    name: 'Copilot',
    config: copilotConfig,
    // copilotToken is normally an object with token/expiresAt/baseUrl; a
    // string here would silently null-degrade in the serializer layer
    // before the state reader was hardened.
    state: { copilotToken: 'not-an-object' },
  })));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('invalid state for copilot'), true);
});

test('PATCH /api/upstreams rejects kind changes and preserves the row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as Record<string, string>;

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-floway-session': adminSession,
    },
    body: JSON.stringify({ kind: 'azure' }),
  });

  assertEquals(patch.status, 400);
  assertEquals(((await patch.json()) as { error?: string }).error, 'kind cannot be changed');
  assertEquals((await repo.upstreams.getById(created.id))?.kind, 'custom');
});

test('PATCH /api/upstreams preserves omitted secrets and re-warms the models cache', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as Record<string, string>;
  // Plant a stale row so the post-PATCH read can verify the warm overwrote
  // it with the new upstream-supplied catalog rather than leaving the old
  // models in place.
  await repo.upstreams.saveModelsCache(created.id, await getCacheGeneration(repo, created.id), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1,
    models: [{ id: 'stale-model', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'fresh-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const patch = await requestApp(`/api/upstreams/${created.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({
          config: {
            endpoints: { openaiResponses: {} },
            ingressHeadersRules: [{ key: 'X-Route', value: 'patched' }],
          },
        }),
      });
      assertEquals(patch.status, 200);
    },
  );

  const updated = await repo.upstreams.getById(created.id);
  assertEquals((updated?.config as Record<string, unknown>).apiKey, 'sk-test');
  assertEquals((updated?.config as Record<string, unknown>).endpoints, { openaiResponses: {} });
  assertEquals((updated?.config as Record<string, unknown>).ingressHeadersRules, [{ key: 'x-route', value: 'patched' }]);

  const cached = updated?.modelsCache;
  assertEquals(cached?.models.map(model => model.id), ['fresh-model']);
  assertEquals(cached!.fetchedAt > 1, true);
});

test('PATCH /api/upstreams keeps Azure as a single endpoint config', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_azure_single_endpoint',
    kind: 'azure',
    name: 'Azure Single Endpoint',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-secret',
      models: [{ upstreamModelId: 'gpt-prod', endpoints: { anthropicMessages: {} } }],
    },
    state: null,
  });

  const patch = await requestApp('/api/upstreams/up_azure_single_endpoint', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-floway-session': adminSession,
    },
    body: JSON.stringify({
      config: {
        models: [{ upstreamModelId: 'gpt-prod', endpoints: { openaiResponses: {} } }],
      },
    }),
  });

  assertEquals(patch.status, 200);
  const stored = await repo.upstreams.getById('up_azure_single_endpoint');
  assertEquals(stored?.config, {
    endpoint: 'https://example.openai.azure.com/openai/v1',
    apiKey: 'az-secret',
    models: [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { openaiResponses: {} } }],
  });
});

test('PATCH /api/upstreams round-trips a flat per-model flagOverrides map', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_azure_flag_overrides',
    kind: 'azure',
    name: 'Azure Per-Model Flags',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-secret',
      models: [{ upstreamModelId: 'gpt-prod', endpoints: { openaiChatCompletions: {} } }],
    },
    state: null,
  });

  const patchFlat = await requestApp('/api/upstreams/up_azure_flag_overrides', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({
      config: {
        models: [{
          upstreamModelId: 'gpt-prod',
          endpoints: { openaiChatCompletions: {} },
          flagOverrides: { 'vendor-deepseek': true },
        }],
      },
    }),
  });
  assertEquals(patchFlat.status, 200);
  const storedFlat = await repo.upstreams.getById('up_azure_flag_overrides');
  const modelsFlat = (storedFlat?.config as { models: { flagOverrides?: unknown }[] }).models;
  assertEquals(modelsFlat[0].flagOverrides, { 'vendor-deepseek': true });
});

test('GET /api/upstreams attaches models-cache freshness to every row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Three upstreams cover the three cache states: no row, warm row, warm row
  // with a follow-up failure annotated via saveModelsCacheError.
  const baseRow = {
    kind: 'custom' as const,
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: { baseUrl: 'https://a.example.com', authStyle: 'bearer', apiKey: 'x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
    state: null,
  };
  await repo.upstreams.save({ ...baseRow, id: 'up_fresh', name: 'Fresh', sortOrder: 0 });
  await repo.upstreams.save({ ...baseRow, id: 'up_warm', name: 'Warm', sortOrder: 1 });
  await repo.upstreams.save({ ...baseRow, id: 'up_failed', name: 'Failed', sortOrder: 2 });

  await repo.upstreams.saveModelsCache('up_warm', { updatedAt: baseRow.updatedAt, config: baseRow.config }, {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [{ id: 'm1', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });
  await repo.upstreams.saveModelsCache('up_failed', { updatedAt: baseRow.updatedAt, config: baseRow.config }, {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [{ id: 'm1', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });
  await repo.upstreams.saveModelsCacheError('up_failed', { updatedAt: baseRow.updatedAt, config: baseRow.config }, { message: 'boom', at: 1_700_000_500_000 });

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  assertEquals(list.status, 200);
  const items = (await list.json()) as JsonObject[];
  const byId = Object.fromEntries(items.map(i => [i.id, i]));

  assertEquals(byId.up_fresh.modelsCache, { fetchedAt: null, lastError: null, modelCount: null });
  assertEquals(byId.up_warm.modelsCache, { fetchedAt: 1_700_000_000_000, lastError: null, modelCount: 1 });
  assertEquals(byId.up_failed.modelsCache, {
    fetchedAt: 1_700_000_000_000,
    lastError: { message: 'boom', at: 1_700_000_500_000 },
    modelCount: 1,
  });
});

test('GET /api/upstream-options returns the minimal picker shape to admin and non-admin callers', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.upstreams.save({
    id: 'up_disabled_custom',
    kind: 'custom',
    name: 'Disabled Custom',
    enabled: false,
    sortOrder: 5,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: { baseUrl: 'https://custom.example.com', authStyle: 'bearer', apiKey: 'sk-secret', endpoints: { openaiChatCompletions: {} } },
    state: null,
  });
  // A disabled upstream is absent from the live catalog, so the picker's count
  // comes from the catalog it stored while it was on.
  await repo.upstreams.saveModelsCache('up_disabled_custom', await getCacheGeneration(repo, 'up_disabled_custom'), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [
      { id: 'm1', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} },
      { id: 'm2', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} },
    ],
  });

  const expected = [
    { id: 'up_copilot', name: 'GitHub Copilot (tester)', kind: 'copilot', enabled: true, hue: 210, cachedModelCount: null },
    { id: 'up_disabled_custom', name: 'Disabled Custom', kind: 'custom', enabled: false, hue: 210, cachedModelCount: 2 },
  ];

  const adminResp = await requestApp('/api/upstream-options', { headers: { 'x-floway-session': adminSession } });
  assertEquals(adminResp.status, 200);
  assertEquals(await adminResp.json(), expected);

  const userResp = await requestApp('/api/upstream-options', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(userResp.status, 200);
  const userBody = await userResp.json() as Array<Record<string, unknown>>;
  assertEquals(userBody, expected);
  // No secret-bearing or operator-only fields leak through this endpoint.
  for (const row of userBody) {
    assertEquals(Object.keys(row).sort(), ['cachedModelCount', 'enabled', 'hue', 'id', 'kind', 'name']);
  }
});

test('POST /api/upstreams/list-models fetches a draft custom upstream model list', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        assertEquals(request.headers.get('authorization'), 'Bearer sk-test');
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-a' }, { id: 'gpt-b', display_name: 'GPT B' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/list-models', authed(adminSession, {
        record: blueprintEnvelope('custom', { config: customConfig }),
      }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      assertEquals(body.data.map(m => m.id), ['gpt-a', 'gpt-b']);
      assertEquals(body.data[1].display_name, 'GPT B');
    },
  );
});

test('POST /api/upstreams/list-models projects an ollama draft into UpstreamModelConfig rows with capability-derived endpoints', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'ollama.com' && url.pathname === '/api/tags') {
        return jsonResponse({ models: [{ name: 'gpt-oss:120b' }, { name: 'nomic-embed-text:latest' }] });
      }
      if (url.hostname === 'ollama.com' && url.pathname === '/api/show') {
        const body = await request.json() as { name?: string };
        if (body.name === 'gpt-oss:120b') {
          return jsonResponse({
            capabilities: ['completion', 'tools', 'thinking'],
            details: { family: 'gptoss' },
            model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': 131072 },
          });
        }
        if (body.name === 'nomic-embed-text:latest') {
          return jsonResponse({
            capabilities: ['embedding'],
            details: { family: 'nomic-bert' },
            model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 8192 },
          });
        }
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/list-models', authed(adminSession, {
        record: blueprintEnvelope('ollama', {
          config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test' },
        }),
      }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      const ids = body.data.map(m => m.upstreamModelId).sort();
      assertEquals(ids, ['gpt-oss:120b', 'nomic-embed-text:latest']);
      const gptoss = body.data.find(m => m.upstreamModelId === 'gpt-oss:120b')!;
      assertEquals(gptoss.kind, 'chat');
      assertEquals(Object.keys(gptoss.endpoints as Record<string, unknown>).sort(), ['anthropicMessages', 'openaiChatCompletions', 'openaiCompletions', 'openaiResponses']);
      const embed = body.data.find(m => m.upstreamModelId === 'nomic-embed-text:latest')!;
      assertEquals(embed.kind, 'embedding');
      assertEquals(Object.keys(embed.endpoints as Record<string, unknown>), ['openaiEmbeddings']);
    },
  );
});

test('POST /api/upstreams/list-models surfaces upstream model-listing failures as 502', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/list-models', authed(adminSession, {
        record: blueprintEnvelope('custom', { config: customConfig }),
      }));
      assertEquals(resp.status, 502);
      const body = (await resp.json()) as { error: { message: string; type: string; code: string } };
      assertEquals(body.error.type, 'api_error');
      assertEquals(body.error.code, MODEL_LISTING_FAILURE_CODE);
    },
  );
});

test('POST /api/upstreams/list-models surfaces an ollama /api/tags failure as 502', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'ollama.com' && url.pathname === '/api/tags') {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/list-models', authed(adminSession, {
        record: blueprintEnvelope('ollama', {
          config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test' },
        }),
      }));
      assertEquals(resp.status, 502);
      const body = (await resp.json()) as { error: { message: string; type: string; code: string } };
      assertEquals(body.error.type, 'api_error');
      assertEquals(body.error.code, MODEL_LISTING_FAILURE_CODE);
    },
  );
});

test('POST /api/upstreams/list-models rejects a malformed draft config with 400', async () => {
  const { adminSession } = await setupAppTest();

  // Blank token with no id and no stored secret to substitute: the runtime
  // assert rejects the empty apiKey, surfaced as a 400 validation error.
  const resp = await requestApp('/api/upstreams/list-models', authed(adminSession, {
    record: blueprintEnvelope('custom', { config: { ...customConfig, apiKey: '' } }),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('apiKey'), true);
});

test('POST /api/upstreams/list-models with a persisted id forces a fresh upstream fetch and updates the SWR cache', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const savedRecord: UpstreamRecord = {
    id: 'up_refresh',
    kind: 'custom',
    name: 'Refresh Custom',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: MOCKED_FETCH_EGRESS,
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: { ...customConfig, apiKey: 'sk-refresh' },
    state: null,
  };
  await repo.upstreams.save(savedRecord);

  let upstreamCalls = 0;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        upstreamCalls += 1;
        return jsonResponse({ object: 'list', data: [{ id: 'fresh-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/list-models', authed(adminSession, {
        record: envelopeFromRecord(savedRecord),
      }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<{ id?: string }> };
      // Custom returns the raw upstream row shape (id-keyed), not the
      // dashboard-projected UpstreamModelConfig — the SPA translates
      // through the draft's endpoints.
      assertEquals(body.data.map(m => m.id), ['fresh-model']);
      assertEquals(upstreamCalls, 1);
      const cached = (await repo.upstreams.getById(savedRecord.id))?.modelsCache;
      assertEquals(cached?.models.map((model: { id: string }) => model.id), ['fresh-model']);
    },
  );
});

test('POST /api/upstreams/list-models rejects an invalid kind with 400', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/list-models', authed(adminSession, {
    record: { id: '', kind: 'bogus-kind', config: {}, state: null },
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: { message: string; type: string } };
  assertEquals(body.error.type, 'invalid_request_error');
});

test('POST /api/upstreams warms the models cache before responding', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'warmed-on-create' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams', authed(adminSession, createBody()));
      assertEquals(resp.status, 201);
      return (await resp.json()) as { id: string; modelsCache: { fetchedAt: number | null; lastError: unknown } };
    },
  );

  const cached = (await repo.upstreams.getById(created.id))?.modelsCache;
  assertEquals(cached?.models.map(model => model.id), ['warmed-on-create']);
  // The dashboard re-seeds its draft from this body, so it has to carry the
  // freshness the warm just produced rather than the record's pre-warm one.
  assertEquals(created.modelsCache.fetchedAt, cached?.fetchedAt ?? null);
  assertEquals(created.modelsCache.lastError, null);
});

test('PATCH /api/upstreams warms the models cache before responding', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as { id: string };
  // Overwrite whatever the create-time warm landed on the row with a marker
  // catalog, so the assertion below can only pass if the PATCH-time warm wrote
  // over it.
  await repo.upstreams.saveModelsCache(created.id, await getCacheGeneration(repo, created.id), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1,
    models: [{ id: 'warmed-on-create', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });
  // …and annotate it with an error the successful PATCH-time warm must clear,
  // so the response body cannot pass by echoing the pre-warm row.
  await repo.upstreams.saveModelsCacheError(created.id, await getCacheGeneration(repo, created.id), { message: 'stale failure', at: 1 });

  const patched = await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'warmed-on-update' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const patch = await requestApp(`/api/upstreams/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      assertEquals(patch.status, 200);
      return (await patch.json()) as { modelsCache: { fetchedAt: number | null; lastError: unknown } };
    },
  );

  const cached = (await repo.upstreams.getById(created.id))?.modelsCache;
  assertEquals(cached?.models.map(model => model.id), ['warmed-on-update']);
  assertEquals(patched.modelsCache.fetchedAt, cached?.fetchedAt ?? null);
  assertEquals(patched.modelsCache.lastError, null);
});

test('POST /api/upstreams/list-models without an id still serves draft preview', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'draft-only' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/list-models', authed(adminSession, {
        record: blueprintEnvelope('custom', { config: customConfig }),
      }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      assertEquals(body.data.map(m => m.id), ['draft-only']);
    },
  );
});

// --- Codex routes ---
//
// The auth.json import path lets us drive the OAuth ingestion deterministically
// without mocking the token-exchange roundtrip: parseCodexIdTokenClaims decodes
// the id_token JWT directly. Build a fake JWT that carries the identity claims
// the production parser requires.
const encodeBase64Url = (input: string): string =>
  btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fakeIdToken = (claims: Record<string, unknown>): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_test',
      chatgpt_user_id: 'usr_test',
      chatgpt_plan_type: 'plus',
    },
    'https://api.openai.com/profile': { email: 'alice@example.com' },
    ...claims,
  }));
  return `${header}.${payload}.fake-signature`;
};

const codexAuthJsonImport = (overrides: Record<string, unknown> = {}) => ({
  auth_json: JSON.stringify({
    tokens: {
      access_token: 'at_test',
      refresh_token: 'rt_test',
      id_token: fakeIdToken({}),
    },
    ...overrides,
  }),
});

// Two-step create flow: (1) exchange endpoint yields a codex config+state
// patch from the fake auth.json blob, (2) POST /api/upstreams persists the
// merged draft. Mirrors the SPA editor's exchange-then-save flow so tests
// touching subsequent codex actions see the same row a real user would
// have.
const createCodexUpstreamViaExchange = async (adminSession: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> => {
  const exchange = await requestApp('/api/upstreams/codex/oauth/exchange', authed(adminSession, {
    record: blueprintEnvelope('codex'),
    auth_json: codexAuthJsonImport(overrides).auth_json,
  }));
  if (exchange.status !== 200) throw new Error(`codex exchange failed: ${exchange.status} ${await exchange.text()}`);
  const { patch } = (await exchange.json()) as { patch: { config: unknown; state: unknown } };
  const create = await requestApp('/api/upstreams', authed(adminSession, {
    kind: 'codex',
    name: 'ChatGPT Codex',
    hue: 210,
    config: patch.config,
    state: patch.state,
    proxy_fallback_list: MOCKED_FETCH_EGRESS,
  }));
  if (create.status !== 201) throw new Error(`codex create failed: ${create.status} ${await create.text()}`);
  return (await create.json()) as { id: string };
};

const getRecord = async (repo: { upstreams: { getById: (id: string) => Promise<UpstreamRecord | null> } }, id: string): Promise<UpstreamRecord> => {
  const record = await repo.upstreams.getById(id);
  if (!record) throw new Error(`Expected upstream ${id} to exist`);
  return record;
};

const getCacheGeneration = async (repo: { upstreams: { getById: (id: string) => Promise<UpstreamRecord | null> } }, id: string) => {
  const record = await getRecord(repo, id);
  return { updatedAt: record.updatedAt, config: record.config };
};

test('POST /api/upstreams/codex/oauth/authorize-url stamps SPA-provided challenge + state into the auth.openai.com URL', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/codex/oauth/authorize-url',
    authed(adminSession, { record: blueprintEnvelope('codex'), challenge: 'TEST_CHALLENGE', state: 'TEST_STATE' }),
  );
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { authorize_url: string };
  const url = new URL(body.authorize_url);
  assertEquals(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assertEquals(url.searchParams.get('code_challenge'), 'TEST_CHALLENGE');
  assertEquals(url.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(url.searchParams.get('state'), 'TEST_STATE');
});

test('POST /api/upstreams/codex/oauth/exchange in create state (callback) returns a codex config+state patch from the SPA-supplied verifier', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_cb', refresh_token: 'rt_cb', id_token: fakeIdToken({}), expires_in: 600 }),
    async () => {
      const resp = await requestApp(
        '/api/upstreams/codex/oauth/exchange',
        authed(adminSession, {
          record: blueprintEnvelope('codex'),
          callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER' },
        }),
      );
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { patch: { config: { accounts: Array<{ email: string }> }; state: { accounts: Array<{ refresh_token: string }> } } };
      assertEquals(body.patch.config.accounts[0].email, 'alice@example.com');
      // Create-flow exchange returns the raw (non-redacted) patch so the SPA
      // can merge credentials into its draft before saving.
      assertEquals(body.patch.state.accounts[0].refresh_token, 'rt_cb');
    },
  );
});

test('POST /api/upstreams/codex/oauth/exchange in create state (auth_json) returns a codex config+state patch derived from the JWT', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/codex/oauth/exchange', authed(adminSession, {
    record: blueprintEnvelope('codex'),
    auth_json: codexAuthJsonImport().auth_json,
  }));
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { patch: { config: JsonObject; state: JsonObject } };
  assertEquals(body.patch.config.accounts[0].email, 'alice@example.com');
  assertEquals(body.patch.config.accounts[0].chatgptAccountId, 'acc_test');
  assertEquals(body.patch.config.accounts[0].planType, 'plus');
  assertEquals(body.patch.state.accounts[0].state, 'active');
  assertEquals(body.patch.state.accounts[0].refresh_token, 'rt_test');
});

test('POST /api/upstreams/codex/oauth/exchange in edit state persists the patch to the stored row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const initial = await createCodexUpstreamViaExchange(adminSession);
  // Re-import with a rotated refresh_token to prove the exchange overwrites
  // config + state on the existing row rather than appending an account.
  await requestApp('/api/upstreams/codex/oauth/exchange', authed(adminSession, {
    record: envelopeFromRecord(await getRecord(repo, initial.id)),
    auth_json: codexAuthJsonImport({
      tokens: { access_token: 'at_v2', refresh_token: 'rt_v2', id_token: fakeIdToken({}) },
    }).auth_json,
  }));

  const stored = await repo.upstreams.getById(initial.id);
  const storedState = stored?.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(storedState.accounts[0].refresh_token, 'rt_v2');
});

test('POST /api/upstreams/codex/oauth/exchange rejects when both auth_json and callback are absent', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/codex/oauth/exchange', authed(adminSession, {
    record: blueprintEnvelope('codex'),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: { issues?: Array<{ message: string }> } | string };
  // The schema-level XOR refine surfaces as a zod validation error envelope.
  assertEquals(JSON.stringify(body).includes('Provide exactly one of auth_json or callback'), true);
});

test('POST /api/upstreams/codex/oauth/refresh rejects a non-codex record with 400', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/codex/oauth/refresh', authed(adminSession, {
    record: blueprintEnvelope('custom', { config: customConfig }),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('codex'), true);
});

test('POST /api/upstreams/codex/oauth/refresh rejects a record in a terminal state with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };
  await repo.upstreams.save({
    ...stored!,
    state: { accounts: storedState.accounts.map(a => ({ ...a, state: 'session_terminated' })) },
  });

  const resp = await requestApp('/api/upstreams/codex/oauth/refresh', authed(adminSession, {
    record: envelopeFromRecord(await getRecord(repo, created.id)),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('session_terminated'), true);
});

test('POST /api/upstreams/codex/oauth/refresh rotates the refresh token and persists to the row when the record has an id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);

  await withMockedFetch(
    () => jsonResponse({
      access_token: 'at_rotated',
      refresh_token: 'rt_rotated',
      id_token: fakeIdToken({}),
      expires_in: 3600,
    }),
    async () => {
      const resp = await requestApp('/api/upstreams/codex/oauth/refresh', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { patch: { state: { accounts: Array<{ refresh_token: string }> } } };
      assertEquals(body.patch.state.accounts[0].refresh_token, 'rt_rotated');
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(storedState.accounts[0].refresh_token, 'rt_rotated');
});

test('POST /api/upstreams/codex/oauth/refresh flips the row to refresh_failed when OAuth rejects the refresh_token', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);

  await withMockedFetch(
    () => new Response(
      JSON.stringify({ error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token.' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
    async () => {
      const resp = await requestApp('/api/upstreams/codex/oauth/refresh', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      // 400, not 502: the upstream answered — it's the stored credential
      // that's dead. Not 401 either, since the dashboard's auth client
      // treats any 401 as a logout signal.
      assertEquals(resp.status, 400);
      const body = await resp.json() as { error: string };
      assertEquals(body.error.toLowerCase().includes('re-run oauth'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; state_message?: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
  assertEquals(typeof storedState.accounts[0].state_message, 'string');
});

test('POST /api/upstreams/codex/reset-credits lists earned reset cards for the stored account', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await createCodexUpstreamViaExchange(adminSession);

  await withMockedFetch(
    request => {
      assertEquals(new URL(request.url).pathname, '/backend-api/wham/rate-limit-reset-credits');
      assertEquals(request.headers.get('authorization'), 'Bearer at_test');
      assertEquals(request.headers.get('chatgpt-account-id'), 'acc_test');
      return jsonResponse({
        available_count: 1,
        credits: [{
          id: 'credit-1', reset_type: 'codex_rate_limits', status: 'available',
          granted_at: '2026-06-17T00:00:00Z', expires_at: null,
          title: 'Full reset', description: 'Ready to redeem',
        }],
      });
    },
    async () => {
      const resp = await requestApp('/api/upstreams/codex/reset-credits', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
      const body = await resp.json() as { reset_credits: { available_count: number; credits: Array<{ id: string }> } };
      assertEquals(body.reset_credits.available_count, 1);
      assertEquals(body.reset_credits.credits[0].id, 'credit-1');
    },
  );
});

test('POST /api/upstreams/codex/reset-credits refreshes once after a definite upstream 401', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await createCodexUpstreamViaExchange(adminSession);
  let listAttempts = 0;

  await withMockedFetch(
    request => {
      const path = new URL(request.url).pathname;
      if (path === '/backend-api/wham/rate-limit-reset-credits') {
        listAttempts += 1;
        if (listAttempts === 1) return new Response('expired', { status: 401 });
        assertEquals(request.headers.get('authorization'), 'Bearer at_rotated');
        return jsonResponse({ available_count: 0, credits: [] });
      }
      if (path === '/oauth/token') {
        return jsonResponse({
          access_token: 'at_rotated', refresh_token: 'rt_rotated',
          id_token: fakeIdToken({}), expires_in: 3600,
        });
      }
      throw new Error(`unexpected Codex request to ${path}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/codex/reset-credits', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
      assertEquals(listAttempts, 2);
    },
  );
  const updated = await getRecord(repo, created.id);
  const updatedState = updated.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(updatedState.accounts[0].refresh_token, 'rt_rotated');
});

test('POST /api/upstreams/codex/reset-credits/consume sends the stable key and invalidates stale quota', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await createCodexUpstreamViaExchange(adminSession);
  const stored = await getRecord(repo, created.id);
  const state = stored.state as { accounts: Array<Record<string, unknown>> };
  await repo.upstreams.save({
    ...stored,
    state: {
      accounts: state.accounts.map(account => ({
        ...account,
        quotaSnapshot: {
          codex: { fetchedAt: Date.now(), data: { observed_at: '2026-06-17T00:00:00Z', primary_used_percent: 100 } },
        },
      })),
    },
  });

  const paths: string[] = [];
  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith('/consume')) {
        assertEquals(await request.json(), { redeem_request_id: 'redeem-stable', credit_id: 'credit-1' });
        return jsonResponse({ code: 'reset', windows_reset: 2 });
      }
      return jsonResponse({ available_count: 0, credits: [] });
    },
    async () => {
      const resp = await requestApp('/api/upstreams/codex/reset-credits/consume', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
        credit_id: 'credit-1',
        idempotency_key: 'redeem-stable',
      }));
      assertEquals(resp.status, 200);
      const body = await resp.json() as { outcome: { code: string }; reset_credits: { available_count: number }; refresh_error: string | null };
      assertEquals(body, { outcome: { code: 'reset' }, reset_credits: { available_count: 0, credits: [] }, refresh_error: null });
    },
  );
  assertEquals(paths, [
    '/backend-api/wham/rate-limit-reset-credits/consume',
    '/backend-api/wham/rate-limit-reset-credits',
  ]);
  const updated = await getRecord(repo, created.id);
  const updatedState = updated.state as { accounts: Array<{ quotaSnapshot: unknown }> };
  assertEquals(updatedState.accounts[0].quotaSnapshot, null);
});

// --- Claude Code routes ---
//
// Test setup mirrors the codex routes: we drive the OAuth + profile fetches
// through withMockedFetch so the import handler runs end-to-end without
// hitting the real upstream.

const claudeCodeProfileBody = {
  account: { uuid: 'acc-uuid-1', email: 'alice@example.com' },
  organization: { uuid: 'org-uuid-1', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
};

const claudeCodeTokenBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'at_test',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt_test',
  scope: 'user:inference',
  ...overrides,
});

const claudeCodeCredentialsJson = (overrides: { accessToken?: string; refreshToken?: string; expiresAt?: number } = {}) => JSON.stringify({
  claudeAiOauth: {
    accessToken: overrides.accessToken ?? 'cli_at',
    refreshToken: overrides.refreshToken ?? 'cli_rt',
    expiresAt: overrides.expiresAt ?? Date.now() + 3_600_000,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  },
});

// SPA-mirroring two-step create for claude-code: (1) exchange yields a
// config+state patch (identity fetched via mocked profile call), (2) POST
// /api/upstreams persists the merged draft. Setup-token override switches
// the exchange endpoint to the setup-token variant.
const createClaudeCodeUpstreamViaExchange = async (
  adminSession: string,
  opts: { credentialsOverrides?: { accessToken?: string; refreshToken?: string; expiresAt?: number } } = {},
): Promise<{ id: string }> => {
  const exchange = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    () => requestApp('/api/upstreams/claude-code/oauth/exchange', authed(adminSession, {
      record: blueprintEnvelope('claude-code'),
      credentials_json: claudeCodeCredentialsJson(opts.credentialsOverrides ?? {}),
    })),
  );
  if (exchange.status !== 200) throw new Error(`claude-code exchange failed: ${exchange.status} ${await exchange.text()}`);
  const { patch } = (await exchange.json()) as { patch: { config: unknown; state: unknown } };
  const create = await requestApp('/api/upstreams', authed(adminSession, {
    kind: 'claude-code',
    name: 'Claude Code',
    hue: 210,
    config: patch.config,
    state: patch.state,
    proxy_fallback_list: MOCKED_FETCH_EGRESS,
  }));
  if (create.status !== 201) throw new Error(`claude-code create failed: ${create.status} ${await create.text()}`);
  return (await create.json()) as { id: string };
};

test('POST /api/upstreams/claude-code/oauth/authorize-url stamps SPA-provided challenge + state into the OAuth URL', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/claude-code/oauth/authorize-url',
    authed(adminSession, { record: blueprintEnvelope('claude-code'), challenge: 'TEST_CHALLENGE', state: 'TEST_STATE' }),
  );
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { authorize_url: string };
  const url = new URL(body.authorize_url);
  assertEquals(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
  assertEquals(url.searchParams.get('code_challenge'), 'TEST_CHALLENGE');
  assertEquals(url.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(url.searchParams.get('state'), 'TEST_STATE');
});

test('POST /api/upstreams/claude-code/oauth/exchange in create state (callback) returns a claude-code config+state patch with a fresh access token', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') return jsonResponse(claudeCodeTokenBody());
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') return jsonResponse(claudeCodeProfileBody);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code/oauth/exchange',
        authed(adminSession, {
          record: blueprintEnvelope('claude-code'),
          callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER', state: 'TEST_STATE' },
        }),
      );
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { patch: { config: JsonObject; state: { accounts: Array<{ refreshToken: string; accessToken: { expiresAt: number; token: string } | null }> } } };
      assertEquals(body.patch.state.accounts[0].refreshToken, 'rt_test');
      assertEquals(typeof body.patch.state.accounts[0].accessToken?.expiresAt, 'number');
      assertEquals(body.patch.state.accounts[0].accessToken?.token, 'at_test');
    },
  );
});

test('POST /api/upstreams/claude-code/oauth/exchange in create state (credentials_json) returns a claude-code config+state patch with the CLI-persisted plan fields', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code/oauth/exchange',
        authed(adminSession, {
          record: blueprintEnvelope('claude-code'),
          credentials_json: claudeCodeCredentialsJson(),
        }),
      );
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { patch: { config: JsonObject; state: JsonObject } };
      assertEquals(body.patch.config.accounts[0].email, 'alice@example.com');
      assertEquals(body.patch.config.accounts[0].accountUuid, 'acc-uuid-1');
      // CLI subscriptionType + rateLimitTier verbatim from credentials.json
      // win over the derived profile fields.
      assertEquals(body.patch.config.accounts[0].subscriptionType, 'max');
      assertEquals(body.patch.config.accounts[0].rateLimitTier, 'default_claude_max_20x');
      assertEquals(body.patch.state.accounts[0].state, 'active');
      assertEquals(body.patch.state.accounts[0].refreshToken, 'cli_rt');
    },
  );
});

test('POST /api/upstreams/claude-code/oauth/exchange rejects when both credentials_json and callback are absent', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/claude-code/oauth/exchange', authed(adminSession, {
    record: blueprintEnvelope('claude-code'),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as unknown;
  assertEquals(JSON.stringify(body).includes('Provide exactly one of credentials_json or callback'), true);
});

test('POST /api/upstreams/claude-code/oauth/exchange rejects a callback missing the verifier', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/claude-code/oauth/exchange',
    authed(adminSession, {
      record: blueprintEnvelope('claude-code'),
      callback: { code: 'AUTH_CODE', state: 'TEST_STATE' },
    }),
  );
  assertEquals(resp.status, 400);
});

test('PATCH /api/upstreams rejects config edits on a claude-code row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ config: { accounts: [] } }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('claude-code'), true);
});

test('PATCH /api/upstreams rejects config edits on a codex row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ config: { accounts: [] } }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('codex'), true);
});

test('PATCH /api/upstreams rejects config edits on a copilot row', async () => {
  const { adminSession, copilotUpstream } = await setupAppTest();

  const patch = await requestApp(`/api/upstreams/${copilotUpstream.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ config: { githubHost: 'github.com', githubToken: 'ghu_hijack', user: { login: 'x', id: 0, avatar_url: '', name: null } } }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('copilot'), true);
});

test('PATCH /api/upstreams accepts metadata edits on a claude-code row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ name: 'My Claude Max', enabled: false }),
  });
  assertEquals(patch.status, 200);
  const body = (await patch.json()) as { name: string; enabled: boolean };
  assertEquals(body.name, 'My Claude Max');
  assertEquals(body.enabled, false);
});

test('POST /api/upstreams/claude-code/oauth/refresh rejects a non-claude-code record with 400', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, {
    record: blueprintEnvelope('custom', { config: customConfig }),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('claude code'), true);
});

test('POST /api/upstreams/claude-code/oauth/refresh rejects a record in a terminal state with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Plant a row in `refresh_failed` by importing then hand-mutating the row.
  const created = await createClaudeCodeUpstreamViaExchange(adminSession);
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };
  await repo.upstreams.save({
    ...stored!,
    state: {
      accounts: storedState.accounts.map(a => ({
        ...a,
        state: 'refresh_failed',
        stateMessage: 'token revoked',
        accessToken: null,
      })),
    },
  });

  const resp = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, {
    record: envelopeFromRecord(await getRecord(repo, created.id)),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('refresh_failed'), true);
});

test('POST /api/upstreams/claude-code/oauth/refresh rotates the refresh token and persists to the row when the record has an id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);

  await withMockedFetch(
    () => jsonResponse(claudeCodeTokenBody({ access_token: 'at_rotated', refresh_token: 'rt_rotated' })),
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { patch: { state: { accounts: Array<{ refreshToken: string }> } } };
      assertEquals(body.patch.state.accounts[0].refreshToken, 'rt_rotated');
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refreshToken: string }> };
  assertEquals(storedState.accounts[0].refreshToken, 'rt_rotated');
});

test('POST /api/upstreams/claude-code/oauth/refresh flips the row to refresh_failed when OAuth rejects the refresh_token', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);

  await withMockedFetch(
    () => new Response(
      JSON.stringify({ error: { code: 'invalid_grant', message: 'Refresh token revoked' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      // 400, not 502: same reasoning as codex — the upstream answered,
      // it's the stored credential that's dead. Not 401 either, to avoid
      // logging the operator out of the dashboard.
      assertEquals(resp.status, 400);
      const body = await resp.json() as { error: string };
      assertEquals(body.error.toLowerCase().includes('re-run oauth'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; stateMessage?: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
  assertEquals(typeof storedState.accounts[0].stateMessage, 'string');
});

// --- proxy_fallback_list ---
//
// The list has set semantics — duplicates are dropped silently before
// storage. Order is meaningful at dial time. Both POST and PATCH normalize
// the list so the wire response matches what GET returns afterwards.

test('POST /api/upstreams accepts proxy_fallback_list and surfaces it in the response', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const resp = await requestApp(
    '/api/upstreams',
    authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }] })),
  );
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }]);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }]);
});

test('POST /api/upstreams normalises proxy_fallback_list duplicates so the response matches what GET returns', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const resp = await requestApp(
    '/api/upstreams',
    authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }, { id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }] })),
  );
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  // Without the API-layer normalize, the response would echo the duplicates
  // while the saved row only kept one of each — operators would see a
  // different list on POST vs the next GET.
  assertEquals(created.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }]);

  const get = await requestApp('/api/upstreams', authed(adminSession));
  const list = (await get.json()) as JsonObject[];
  const fresh = list.find(u => u.id === created.id);
  assertEquals(fresh!.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }]);
});

test('PATCH /api/upstreams sets proxy_fallback_list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody({ proxy_fallback_list: [] })));
  const created = (await create.json()) as { id: string; proxy_fallback_list: { id: string; colos?: string[] }[] };
  assertEquals(created.proxy_fallback_list, []);

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ proxy_fallback_list: [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }] }),
  });
  assertEquals(patch.status, 200);
  const updated = (await patch.json()) as JsonObject;
  assertEquals(updated.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }]);
});

test('PATCH /api/upstreams rejects proxy_fallback_list referencing an unknown proxy id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as { id: string };

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ proxy_fallback_list: [{ id: 'nope' }] }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('GET /api/upstreams drops a fallback entry whose proxy is gone, keeping direct transports', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_live', name: 'Live', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_live' }, { id: 'direct_fetch' }] })));
  const created = (await create.json()) as { id: string };
  // A proxy delete is refused while an upstream still names it, so reach past
  // the route to reproduce a raced delete or a hand-edited row.
  const stored = await repo.upstreams.getById(created.id);
  await repo.upstreams.save({ ...stored!, proxyFallbackList: [{ id: 'p_gone' }, { id: 'p_live' }, { id: 'direct_fetch' }] });

  const single = await requestApp(`/api/upstreams/${created.id}`, { headers: { 'x-floway-session': adminSession } });
  assertEquals(single.status, 200);
  assertEquals(((await single.json()) as JsonObject).proxy_fallback_list, [{ id: 'p_live' }, { id: 'direct_fetch' }]);

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  const rows = (await list.json()) as JsonObject[];
  assertEquals(rows.find(row => row.id === created.id)?.proxy_fallback_list, [{ id: 'p_live' }, { id: 'direct_fetch' }]);

  // The stored row keeps the entry: only a write that targets the list rewrites it.
  assertEquals((await repo.upstreams.getById(created.id))?.proxyFallbackList.map(entry => entry.id), ['p_gone', 'p_live', 'direct_fetch']);
});

test('DELETE /api/upstreams sweeps orphaned proxy backoff rows', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_a', name: 'A', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_a' }] })));
  const created = (await create.json()) as { id: string };

  await repo.proxyBackoffs.recordDialFailure('p_a', created.id, 'tcp refused');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'other_upstream', 'tcp refused');
  assertEquals((await repo.proxyBackoffs.listAll()).length, 2);

  const del = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'DELETE',
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(del.status, 200);

  const remaining = await repo.proxyBackoffs.listAll();
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0]!.upstreamId, 'other_upstream');
});

// --- pre-save proxy_fallback_list override ---

test('POST /api/upstreams/claude-code/oauth/refresh honors the record.proxy_fallback_list over the persisted list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Stash a real proxy id so the persisted list has a non-direct entry; the
  // envelope below points at a different (unknown) id, so a 400 from the
  // route proves the envelope's list won — not the persisted row.
  await repo.proxies.insert({ id: 'p_real', name: 'Real', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);
  // Persist a non-direct fallback list so a successful default-path refresh
  // would route through `p_real`. The envelope's list should win.
  await repo.upstreams.save({ ...(await getRecord(repo, created.id)), proxyFallbackList: [{ id: 'p_real' }] });

  const envelope = envelopeFromRecord(await getRecord(repo, created.id));
  envelope.proxy_fallback_list = [{ id: 'p_unknown' }];
  const resp = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, { record: envelope }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/codex/oauth/refresh honors the record.proxy_fallback_list over the persisted list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);

  const envelope = envelopeFromRecord(await getRecord(repo, created.id));
  envelope.proxy_fallback_list = [{ id: 'p_unknown' }];
  const resp = await requestApp('/api/upstreams/codex/oauth/refresh', authed(adminSession, { record: envelope }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/claude-code/oauth/refresh resolves an empty record.proxy_fallback_list to direct-connect egress', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);

  // An empty list is the "no policy" state, not a config error: it never
  // engages proxy-catalog validation (which would answer 400) and instead
  // resolves to the default direct-connect transport. The app-test SocketDial
  // refuses, so the dial reaching the OAuth host is the proof it got there.
  const resp = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, {
    record: { ...envelopeFromRecord(await getRecord(repo, created.id)), proxy_fallback_list: [] },
  }));
  assertEquals(resp.status, 502);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('tcp connect to platform.claude.com:443 failed'), true);
});

test('POST /api/upstreams/copilot/oauth/device-login/poll honors the record.proxy_fallback_list', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp(
    '/api/upstreams/copilot/oauth/device-login/poll',
    authed(adminSession, {
      record: blueprintEnvelope('copilot', { proxy_fallback_list: [{ id: 'p_unknown' }] }),
      deviceCode: 'dev',
    }),
  );
  // resolveControlPlaneFetcher throws synchronously when validating the
  // override; the handler maps that to a 400 (config error, not upstream
  // error) with the error message intact. Mirrors codex / claude-code
  // refresh which reject the same shape as 400.
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

// --- import / reimport proxy_fallback_list override ---
//
// Import and re-import fire before (or alongside) a save, so the operator's
// in-flight proxy edit must accompany the request. Two behaviors:
//   1. The bootstrap call (OAuth token exchange + identity fetch) routes
//      through the override.
//   2. The override is persisted on the new (import) / existing (re-import)
//      row so subsequent data-plane calls use the same chain without a
//      follow-up edit.

// --- exchange proxy_fallback_list override ---
//
// The exchange endpoint runs the OAuth bootstrap (token exchange + identity
// fetch) BEFORE any row exists, so the operator's in-flight proxy edit must
// travel on the envelope. The endpoint doesn't persist proxy_fallback_list;
// storage is the caller's follow-up POST /api/upstreams.

test('POST /api/upstreams/claude-code/oauth/exchange rejects a record.proxy_fallback_list referencing an unknown proxy id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp(
    '/api/upstreams/claude-code/oauth/exchange',
    authed(adminSession, {
      record: blueprintEnvelope('claude-code', { proxy_fallback_list: [{ id: 'p_unknown' }] }),
      credentials_json: claudeCodeCredentialsJson(),
    }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/codex/oauth/exchange rejects a record.proxy_fallback_list referencing an unknown proxy id', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/codex/oauth/exchange',
    authed(adminSession, {
      record: blueprintEnvelope('codex', { proxy_fallback_list: [{ id: 'p_unknown' }] }),
      ...codexAuthJsonImport(),
    }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

// --- claude-code Setup-Token routes ---

const claudeCodeSetupTokenBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'st_long_lived',
  token_type: 'Bearer',
  expires_in: 31536000,
  scope: 'user:inference',
  ...overrides,
});

const claudeCodePermissionError403 = () => jsonResponse(
  { error: { type: 'permission_error', message: 'token lacks user:profile scope' } },
  403,
);

// Setup-token exchange helper. Runs the two-step create flow (exchange +
// POST /api/upstreams) with the mocked upstream serving a long-lived
// bearer, and returns the new upstream id.
const createClaudeCodeSetupTokenUpstreamViaExchange = async (
  adminSession: string,
  callbackCode: string = 'AUTH_CODE',
  callbackVerifier: string = 'TEST_VERIFIER',
  tokenOverrides: Record<string, unknown> = {},
): Promise<{ id: string }> => {
  const exchange = await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') {
        // Verify the exchange body asks for the long-lived bearer.
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        assertEquals(body.expires_in, 31536000);
        return jsonResponse(claudeCodeSetupTokenBody(tokenOverrides));
      }
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') {
        // Setup-token bearer lacks user:profile; the import path falls back
        // to a degraded identity rather than refusing the exchange.
        return claudeCodePermissionError403();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    () => requestApp('/api/upstreams/claude-code/setup-token/exchange', authed(adminSession, {
      record: blueprintEnvelope('claude-code'),
      callback: { code: callbackCode, verifier: callbackVerifier, state: 'TEST_STATE' },
    })),
  );
  if (exchange.status !== 200) throw new Error(`Setup-token exchange failed: ${exchange.status} ${await exchange.text()}`);
  const { patch } = (await exchange.json()) as { patch: { config: unknown; state: unknown } };
  const create = await requestApp('/api/upstreams', authed(adminSession, {
    kind: 'claude-code',
    name: 'Claude Code',
    hue: 210,
    config: patch.config,
    state: patch.state,
    proxy_fallback_list: MOCKED_FETCH_EGRESS,
  }));
  if (create.status !== 201) throw new Error(`Setup-token create failed: ${create.status} ${await create.text()}`);
  return (await create.json()) as { id: string };
};

test('POST /api/upstreams/claude-code/setup-token/authorize-url narrows the scope to user:inference', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/claude-code/setup-token/authorize-url',
    authed(adminSession, { record: blueprintEnvelope('claude-code'), challenge: 'TEST_CHALLENGE', state: 'TEST_STATE' }),
  );
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { authorize_url: string };
  const url = new URL(body.authorize_url);
  assertEquals(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
  assertEquals(url.searchParams.get('scope'), 'user:inference');
});

test('POST /api/upstreams/claude-code/setup-token/exchange in create state returns a setup-token config+state patch with tokenKind and a degraded identity', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') {
        // Verify the exchange body asks for the long-lived bearer.
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        assertEquals(body.expires_in, 31536000);
        return jsonResponse(claudeCodeSetupTokenBody());
      }
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') {
        return claudeCodePermissionError403();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code/setup-token/exchange',
        authed(adminSession, {
          record: blueprintEnvelope('claude-code'),
          callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER', state: 'TEST_STATE' },
        }),
      );
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as {
        patch: {
          config: { accounts: Array<{ email: string | null; accountUuid: string }> };
          state: { accounts: Array<{ tokenKind: string; refreshToken: string | null; accessToken: { token: string; expiresAt: number } | null }> };
        };
      };
      assertEquals(body.patch.state.accounts[0].tokenKind, 'setup-token');
      // No refresh token for setup-token — the long-lived bearer has no
      // rotation counterpart.
      assertEquals(body.patch.state.accounts[0].refreshToken, null);
      // Degraded identity: null email + deterministic UUID.
      assertEquals(body.patch.config.accounts[0].email, null);
      // Long-lived expiry — at least 360 days out.
      const expiresAt = body.patch.state.accounts[0].accessToken?.expiresAt ?? 0;
      assertEquals(expiresAt > Date.now() + 360 * 24 * 60 * 60 * 1000, true);
    },
  );
});

test('POST /api/upstreams/claude-code/oauth/refresh rejects setup-token credentials', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeSetupTokenUpstreamViaExchange(adminSession);

  const refresh = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, {
    record: envelopeFromRecord(await getRecord(repo, created.id)),
  }));
  assertEquals(refresh.status, 400);
  const body = (await refresh.json()) as { error: string };
  assertEquals(body.error.includes('Setup-token'), true);
});

test('POST /api/upstreams/claude-code/setup-token/exchange in edit state replaces credentials in place', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeSetupTokenUpstreamViaExchange(adminSession, 'AUTH_CODE_1', 'VERIFIER_1', { access_token: 'st_v1' });

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') return jsonResponse(claudeCodeSetupTokenBody({ access_token: 'st_v2' }));
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') return claudeCodePermissionError403();
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/setup-token/exchange', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
        callback: { code: 'AUTH_CODE_2', verifier: 'VERIFIER_2', state: 'TEST_STATE' },
      }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ tokenKind: string; accessToken: { token: string } | null }> };
  assertEquals(storedState.accounts[0].tokenKind, 'setup-token');
  assertEquals(storedState.accounts[0].accessToken?.token, 'st_v2');
});

test('POST /api/upstreams/codex/oauth/refresh resolves an empty record.proxy_fallback_list to direct-connect egress', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);

  // Same boundary as the claude-code case: an empty list is accepted as
  // "no policy" and resolves to direct-connect, rather than being rejected
  // as an unknown proxy id.
  const resp = await requestApp('/api/upstreams/codex/oauth/refresh', authed(adminSession, {
    record: { ...envelopeFromRecord(await getRecord(repo, created.id)), proxy_fallback_list: [] },
  }));
  assertEquals(resp.status, 502);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('tcp connect to auth.openai.com:443 failed'), true);
});

// --- POST /api/upstreams/claude-code/probe ---

const usageProbeBody = {
  five_hour: { utilization: 0.42, resets_at: '2026-06-19T20:00:00Z' },
  seven_day: { utilization: 0.10, resets_at: '2026-06-25T18:00:00Z' },
  seven_day_sonnet: { utilization: 0.05, resets_at: '2026-06-25T18:00:00Z' },
};

test('POST /api/upstreams/claude-code/probe returns Anthropic body verbatim and persists into state', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://api.anthropic.com/api/oauth/usage') {
        assertEquals(request.headers.get('authorization'), 'Bearer cli_at');
        assertEquals(request.headers.get('anthropic-beta'), 'oauth-2025-04-20');
        return jsonResponse(usageProbeBody);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/probe', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as {
        fetched_at: string;
        body: Record<string, unknown>;
        patch: { state: { accounts: Array<{ refreshToken: string; accessToken?: { token: string }; usageProbeSnapshot?: { data: Record<string, unknown> } }> } };
      };
      assertEquals(typeof body.fetched_at, 'string');
      assertEquals(body.body, usageProbeBody);
      // The patch's state slot MUST be a full account slice, not a partial
      // `{ usageProbeSnapshot }`; frontend applyPatch does whole-slot
      // replacement and a partial would clobber refreshToken/accessToken.
      assertEquals(body.patch.state.accounts[0].refreshToken, 'cli_rt');
      assertEquals(body.patch.state.accounts[0].accessToken?.token, 'cli_at');
      assertEquals(body.patch.state.accounts[0].usageProbeSnapshot?.data, usageProbeBody);
    },
  );

  // The persisted snapshot is observable via the next GET /api/upstreams.
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ usageProbeSnapshot: { fetchedAt: number; data: Record<string, unknown> } | null }> };
  assertEquals(storedState.accounts[0].usageProbeSnapshot?.data, usageProbeBody);
  assertEquals(typeof storedState.accounts[0].usageProbeSnapshot?.fetchedAt, 'number');
});

test('POST /api/upstreams/claude-code/probe mints a fresh access token when the cached one is stale', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Create with a fresh access token so the create-time cache warm doesn't
  // trip an unwanted refresh through the (unmocked) globalThis.fetch, then
  // stale the persisted state directly so the probe's
  // ensureClaudeCodeAccessToken call falls through to the refresh path.
  const created = await createClaudeCodeUpstreamViaExchange(adminSession);
  const staleRow = await getRecord(repo, created.id);
  const staleState = staleRow.state as { accounts: Array<Record<string, unknown> & { accessToken: Record<string, unknown> | null }> };
  await repo.upstreams.save({
    ...staleRow,
    state: {
      accounts: staleState.accounts.map(a => ({
        ...a,
        accessToken: a.accessToken === null ? null : { ...a.accessToken, expiresAt: Date.now() - 60_000 },
      })),
    },
  });

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') {
        return jsonResponse(claudeCodeTokenBody({ access_token: 'at_refreshed', refresh_token: 'rt_v2' }));
      }
      if (request.url === 'https://api.anthropic.com/api/oauth/usage') {
        // Probe rides on the freshly-minted access token, not the stale one.
        assertEquals(request.headers.get('authorization'), 'Bearer at_refreshed');
        return jsonResponse(usageProbeBody);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/probe', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
    },
  );
});

test('POST /api/upstreams/claude-code/probe surfaces upstream 401 as 502', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);

  await withMockedFetch(
    () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/probe', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 502);
      const body = (await resp.json()) as { error: string };
      assertEquals(body.error.includes('401'), true);
    },
  );
});

test('POST /api/upstreams/claude-code/probe rejects non-claude-code records with 400', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/claude-code/probe', authed(adminSession, {
    record: blueprintEnvelope('custom', { config: customConfig }),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('claude-code'), true);
});

// A minimal but shape-complete `/copilot_internal/user` body. The quota
// endpoint projects it onto the same snapshot shape the data-plane headers
// produce, so both sources render identically on the dashboard.
const sampleCopilotQuotaBody = {
  access_type_sku: 'copilot_pro',
  analytics_tracking_id: 'trk-1',
  assigned_date: '2026-01-01T00:00:00Z',
  can_signup_for_limited: false,
  chat_enabled: true,
  copilot_plan: 'individual',
  organization_login_list: [],
  organization_list: [],
  quota_reset_date: '2026-07-01',
  quota_reset_date_utc: '2026-07-01T00:00:00.000Z',
  quota_snapshots: {
    chat: { entitlement: 300, overage_count: 0, overage_permitted: false, percent_remaining: 100, quota_id: 'chat', quota_remaining: 300, remaining: 300, unlimited: false },
    completions: { entitlement: 0, overage_count: 0, overage_permitted: false, percent_remaining: 100, quota_id: 'completions', quota_remaining: 0, remaining: 0, unlimited: true },
    premium_interactions: { entitlement: 300, overage_count: 0, overage_permitted: false, percent_remaining: 90, quota_id: 'premium_interactions', quota_remaining: 270, remaining: 270, unlimited: false },
  },
};

// --- spec invariant (3): server ignores non-action fields in body ---
//
// Every action endpoint takes a full-record envelope for RPC-client typing
// convenience, but semantics only permit patching the fields the action
// owns. A caller who mutates envelope-only fields (name, flag_overrides,
// sort_order, enabled, model_prefix, disabled_public_model_ids, and — for
// the persistence side — proxy_fallback_list, which is a routing override
// never persisted from an action endpoint) MUST see those mutations
// dropped: the stored row keeps its original value.

test('spec invariant (3): POST /api/upstreams/copilot/oauth/device-login/poll ignores record.name mutation', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  const originalName = copilotUpstream.name;

  const envelope = envelopeFromRecord(await getRecord(repo, copilotUpstream.id));
  envelope.name = 'Mutated';

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://github.com/login/oauth/access_token') {
        return jsonResponse({ access_token: 'ghu_rotated', token_type: 'bearer', scope: 'read:user' });
      }
      if (request.url === 'https://api.github.com/user') {
        return jsonResponse({ id: 42, login: 'rotated', name: null, avatar_url: 'https://example.com/rot.png' });
      }
      if (request.url === 'https://api.github.com/copilot_internal/v2/token') {
        return jsonResponse({ token: 'ct_rotated', expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1800, endpoints: { api: 'https://api.githubcopilot.com' } });
      }
      // The post-save models-cache warm hits `/models` on the copilot API
      // host; 403 short-circuits the auth retry loop instead of racing the
      // ~7s exponential backoff.
      return jsonResponse({ error: 'forbidden' }, 403);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/copilot/oauth/device-login/poll', authed(adminSession, {
        record: envelope,
        deviceCode: 'dev_test',
      }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(copilotUpstream.id);
  assertEquals(stored?.name, originalName);
});

test('spec invariant (3): POST /api/upstreams/copilot/quota ignores record.flag_overrides mutation', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  const originalFlags = { ...copilotUpstream.flagOverrides };

  const envelope = envelopeFromRecord(await getRecord(repo, copilotUpstream.id));
  envelope.flag_overrides = { 'vendor-kimi': true };

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://api.github.com/copilot_internal/user') {
        return jsonResponse(sampleCopilotQuotaBody);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(copilotUpstream.id);
  assertEquals(stored?.flagOverrides, originalFlags);
});

test('spec invariant (3): POST /api/upstreams/codex/oauth/exchange (edit state) ignores record.name mutation', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);
  const record = await getRecord(repo, created.id);
  const originalName = record.name;
  const envelope = envelopeFromRecord(record);
  envelope.name = 'Mutated';

  const resp = await requestApp('/api/upstreams/codex/oauth/exchange', authed(adminSession, {
    record: envelope,
    auth_json: codexAuthJsonImport({
      tokens: { access_token: 'at_v2', refresh_token: 'rt_v2', id_token: fakeIdToken({}) },
    }).auth_json,
  }));
  assertEquals(resp.status, 200);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.name, originalName);
});

test('spec invariant (3): POST /api/upstreams/codex/oauth/refresh ignores record.sort_order mutation', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);
  const record = await getRecord(repo, created.id);
  const originalSortOrder = record.sortOrder;
  const envelope = envelopeFromRecord(record);
  envelope.sort_order = 9999;

  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_rotated', refresh_token: 'rt_rotated', id_token: fakeIdToken({}), expires_in: 3600 }),
    async () => {
      const resp = await requestApp('/api/upstreams/codex/oauth/refresh', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.sortOrder, originalSortOrder);
});

test('spec invariant (3): POST /api/upstreams/claude-code/oauth/exchange (edit state) ignores record.enabled mutation', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);
  const record = await getRecord(repo, created.id);
  const originalEnabled = record.enabled;
  const envelope = envelopeFromRecord(record);
  envelope.enabled = !originalEnabled;

  await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/oauth/exchange', authed(adminSession, {
        record: envelope,
        credentials_json: claudeCodeCredentialsJson({ refreshToken: 'cli_rt_v2' }),
      }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.enabled, originalEnabled);
});

test('spec invariant (3): POST /api/upstreams/claude-code/oauth/refresh ignores record.model_prefix mutation', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);
  const record = await getRecord(repo, created.id);
  const originalModelPrefix = record.modelPrefix;
  const envelope = envelopeFromRecord(record);
  envelope.model_prefix = { prefix: 'anthropic/', addressable: ['prefixed'], listed: ['prefixed'] };

  await withMockedFetch(
    () => jsonResponse(claudeCodeTokenBody({ access_token: 'at_rotated', refresh_token: 'rt_rotated' })),
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.modelPrefix, originalModelPrefix);
});

test('spec invariant (3): POST /api/upstreams/claude-code/setup-token/exchange (edit state) ignores record.disabled_public_model_ids mutation', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeSetupTokenUpstreamViaExchange(adminSession);
  const record = await getRecord(repo, created.id);
  const originalDisabled = [...record.disabledPublicModelIds];
  const envelope = envelopeFromRecord(record);
  envelope.disabled_public_model_ids = ['claude-sonnet-4-5'];

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') return jsonResponse(claudeCodeSetupTokenBody({ access_token: 'st_v2' }));
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') return claudeCodePermissionError403();
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/setup-token/exchange', authed(adminSession, {
        record: envelope,
        callback: { code: 'AUTH_CODE_2', verifier: 'VERIFIER_2', state: 'TEST_STATE' },
      }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.disabledPublicModelIds, originalDisabled);
});

test('spec invariant (3): POST /api/upstreams/claude-code/probe does not persist record.proxy_fallback_list mutations', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_persisted', name: 'Persisted', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);
  // Persist a non-default fallback list — this is what MUST survive the
  // probe. The envelope's list serves ONLY as a per-request routing
  // override; the probe endpoint never writes it back.
  await repo.upstreams.save({ ...(await getRecord(repo, created.id)), proxyFallbackList: [{ id: 'p_persisted' }] });
  const originalList = (await getRecord(repo, created.id)).proxyFallbackList;

  const envelope = envelopeFromRecord(await getRecord(repo, created.id));
  envelope.proxy_fallback_list = [{ id: 'direct_fetch' }];

  await withMockedFetch(
    () => jsonResponse(usageProbeBody),
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/probe', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, originalList);
});

test('spec invariant (3): POST /api/upstreams/list-models ignores record.name mutation on a saved row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  // Azure sits in the SWR-cached branch alongside copilot / codex /
  // claude-code, so this exercises the `fetchUpstreamModelsCached` path a
  // future "refresh row metadata" regression would land in. Azure's
  // getProvidedModels reads directly from config.models — no upstream mock
  // needed, no credential mint.
  const savedRecord: UpstreamRecord = {
    id: 'up_invariant_list_models',
    kind: 'azure',
    name: 'Original',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      endpoint: 'https://invariant.openai.azure.com',
      apiKey: 'sk-invariant',
      models: [{ upstreamModelId: 'gpt-4o', publicModelId: 'gpt-4o', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
    },
    state: null,
  };
  await repo.upstreams.save(savedRecord);

  const envelope = envelopeFromRecord(savedRecord);
  envelope.name = 'Mutated';

  const resp = await requestApp('/api/upstreams/list-models', authed(adminSession, { record: envelope }));
  assertEquals(resp.status, 200);

  const stored = await repo.upstreams.getById(savedRecord.id);
  assertEquals(stored?.name, savedRecord.name);
});

// --- Group B: endpoint tests for surfaces with zero coverage ---
//
// GET /api/upstreams/blueprint — the create page's loader consumes this so
// the shared upstream editor serves both create and edit; the
// blueprint is a shape-complete blank editor response that never touches
// the DB or an assert. GET /api/upstreams/:id — the unredacted single-record
// read the edit page depends on. POST /api/upstreams/copilot/quota — the
// operator-driven refresh of the seat's entitlement snapshot.

test('GET /api/upstreams/blueprint round-trips a shape-complete blank for every kind', async () => {
  const { adminSession } = await setupAppTest();
  const kinds: UpstreamProviderKind[] = ['copilot', 'custom', 'azure', 'codex', 'claude-code', 'ollama'];
  for (const kind of kinds) {
    const resp = await requestApp(`/api/upstreams/blueprint?kind=${kind}`, { headers: { 'x-floway-session': adminSession } });
    assertEquals(resp.status, 200);
    const body = (await resp.json()) as JsonObject;
    assertEquals(body.id, '');
    assertEquals(body.kind, kind);
    assertEquals(body.config !== null && typeof body.config === 'object', true);
    assertEquals(body.modelsCache, { fetchedAt: null, lastError: null, modelCount: null });
  }
});

test('GET /api/upstreams/blueprint rejects an unknown kind with 400', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/upstreams/blueprint?kind=bogus', { headers: { 'x-floway-session': adminSession } });
  assertEquals(resp.status, 400);
});

test('GET /api/upstreams/blueprint serves the record a new upstream starts as with provider flag defaults filled in', async () => {
  const { adminSession } = await setupAppTest();

  // The blueprint is the create form's opening record, so it carries the
  // starting values as well as the shape: a custom upstream opens on an
  // OpenAI-compatible chat endpoint with catalog fetching on. Serialization is
  // a static registry lookup so no provider asserter runs against it.
  // Credentials are editable empty strings, not redacted `*Set` projections.
  const custom = (await (await requestApp('/api/upstreams/blueprint?kind=custom', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(custom.config.authStyle, 'bearer');
  assertEquals(custom.config.apiKey, '');
  assertEquals(custom.config.endpoints, { openaiChatCompletions: {} });
  assertEquals(custom.config.ingressHeadersRules, []);
  assertEquals(custom.config.modelsFetch, { enabled: true });
  const azure = (await (await requestApp('/api/upstreams/blueprint?kind=azure', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(azure.config.models, []);
  const ollama = (await (await requestApp('/api/upstreams/blueprint?kind=ollama', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(ollama.config.apiKey, '');

  // `flag_defaults` on the wire is the whole point of the blueprint;
  // assert it lands on every kind so the dashboard's "Inherit → on/off"
  // pill has data to render before Save.
  for (const kind of ['copilot', 'custom', 'azure', 'codex', 'claude-code', 'ollama']) {
    const preview = (await (await requestApp(`/api/upstreams/blueprint?kind=${kind}`, { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
    assertEquals(typeof preview.flag_defaults['strip-billing-attribution'], 'boolean');
  }

  // Spot-check the two provider-computed decisions we care about at the
  // wire boundary. copilot keeps `strip-billing-attribution` on so the
  // Claude Code billing block never reaches its OpenAI-compatible upstream
  // prompt cache; claude-code keeps it off so plan-tier attribution reaches
  // Anthropic verbatim.
  const copilotPreview = (await (await requestApp('/api/upstreams/blueprint?kind=copilot', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(copilotPreview.flag_defaults['strip-billing-attribution'], true);
  assertEquals(copilotPreview.flag_defaults['rewrite-mid-conv-system-to-user'], false);
  const ccPreview = (await (await requestApp('/api/upstreams/blueprint?kind=claude-code', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(ccPreview.flag_defaults['strip-billing-attribution'], false);
});

test('GET /api/upstreams/:id returns the full record with fresh Codex quota for the edit page', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);
  const stored = await getRecord(repo, created.id);
  const quota = {
    observed_at: new Date().toISOString(),
    active_limit: 'premium',
    primary_used_percent: 7,
    primary_window_minutes: 300,
  };
  const state = structuredClone(stored.state) as JsonObject;
  state.accounts[0].quotaSnapshot = {
    premium: { fetchedAt: Date.now(), data: quota },
  };
  await repo.upstreams.saveState(created.id, () => state);

  const resp = await requestApp(`/api/upstreams/${created.id}`, { headers: { 'x-floway-session': adminSession } });
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as JsonObject;
  assertEquals(body.id, created.id);
  assertEquals(body.codex_quota, { premium: quota });
  // Unredacted: the refresh_token secret is present verbatim, not projected
  // as the list-view's `refresh_token_set` boolean.
  assertEquals(body.state.accounts[0].refresh_token, 'rt_test');
  assertEquals('refresh_token_set' in body.state.accounts[0], false);
});

test('GET /api/upstreams/:id returns null Codex quota when no fresh snapshot exists', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);
  const resp = await requestApp(`/api/upstreams/${created.id}`, { headers: { 'x-floway-session': adminSession } });
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as JsonObject;
  assertEquals('codex_quota' in body, true);
  assertEquals(body.codex_quota, null);
});

test('GET /api/upstreams/:id omits Codex quota from non-Codex responses', async () => {
  const { adminSession } = await setupAppTest();
  const createdResp = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  assertEquals(createdResp.status, 201);
  const created = (await createdResp.json()) as JsonObject;

  const resp = await requestApp(`/api/upstreams/${created.id}`, { headers: { 'x-floway-session': adminSession } });
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as JsonObject;
  assertEquals('codex_quota' in body, false);
});

test('GET /api/upstreams/:id returns 404 for an unknown id', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/upstreams/up_never', { headers: { 'x-floway-session': adminSession } });
  assertEquals(resp.status, 404);
});

test('POST /api/upstreams/copilot/quota projects the GitHub body and persists it into upstream state', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  const envelope = envelopeFromRecord(await getRecord(repo, copilotUpstream.id));

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://api.github.com/copilot_internal/user') {
        return jsonResponse(sampleCopilotQuotaBody);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { reset_at: string; quotas: Record<string, JsonObject> };
      assertEquals(body.reset_at, '2026-07-01T00:00:00.000Z');
      assertEquals(Object.keys(body.quotas).sort(), ['chat', 'completions', 'premium_interactions']);
      assertEquals(body.quotas.premium_interactions, {
        entitlement: 300,
        overage_count: 0,
        overage_permitted: false,
        percent_remaining: 90,
        quota_remaining: 270,
        unlimited: false,
      });
    },
  );

  // The refresh writes the same slot the data plane fills, so the dashboard
  // reads one snapshot regardless of which source observed the seat last.
  const stored = await repo.upstreams.getById(copilotUpstream.id);
  const snapshot = (stored?.state as { quotaSnapshot: { data: { quotas: Record<string, JsonObject> } } }).quotaSnapshot;
  assertEquals(snapshot.data.quotas.premium_interactions.quota_remaining, 270);
});

// The passive header path refuses to write an empty snapshot so a good
// reading survives; the operator refresh has to honour the same contract, or
// pressing Refresh against a body on the pre-2026-06 shape — which carries no
// `quota_snapshots` — would erase what the headers harvested.
test('POST /api/upstreams/copilot/quota leaves the stored snapshot alone when the body reports no buckets', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  const stored = await repo.upstreams.getById(copilotUpstream.id);
  if (!stored) throw new Error('copilot upstream missing');
  const harvested = {
    fetchedAt: 1_700_000_000_000,
    data: {
      observed_at: '2026-08-01T00:00:00.000Z',
      reset_at: '2026-09-01T00:00:00.000Z',
      quotas: { chat: { entitlement: 50, overage_count: 0, overage_permitted: false, percent_remaining: 80, quota_remaining: 40, unlimited: false } },
    },
  };
  await repo.upstreams.saveState(
    copilotUpstream.id,
    current => ({ ...(current as Record<string, unknown>), quotaSnapshot: harvested }),
  );

  const envelope = envelopeFromRecord(await getRecord(repo, copilotUpstream.id));
  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://api.github.com/copilot_internal/user') {
        return jsonResponse({ access_type_sku: 'free_limited_copilot', copilot_plan: 'individual', limited_user_quotas: { chat: 500, completions: 3876 }, monthly_quotas: { chat: 500, completions: 4000 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
      assertEquals(await resp.json(), null);
    },
  );

  const after = await repo.upstreams.getById(copilotUpstream.id);
  assertEquals((after?.state as { quotaSnapshot: unknown }).quotaSnapshot, harvested);
});

test('POST /api/upstreams/copilot/quota rejects a non-copilot record with 400', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, {
    record: blueprintEnvelope('custom', { config: customConfig }),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('copilot'), true);
});

test('POST /api/upstreams/copilot/quota rejects a record missing its GitHub token with 400', async () => {
  const { adminSession } = await setupAppTest();
  // Blueprint copilot has githubToken: '' — the handler's presence check
  // rejects with 400 before any upstream call.
  const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, {
    record: blueprintEnvelope('copilot'),
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('github token'), true);
});

test('POST /api/upstreams/copilot/quota rejects an invalid GitHub host with 400', async () => {
  const { adminSession } = await setupAppTest();
  const envelope = blueprintEnvelope('copilot', {
    config: { ...copilotConfig, githubHost: 'https://github.com' },
  });
  const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, { record: envelope }));
  assertEquals(resp.status, 400);
  assertEquals(await resp.json(), { error: 'GitHub host must be github.com or a tenant hostname ending in .ghe.com' });
});

test('POST /api/upstreams/copilot/quota remaps upstream 401 to 502 and passes upstream 500 through', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  const envelope = envelopeFromRecord(await getRecord(repo, copilotUpstream.id));

  await withMockedFetch(
    () => jsonResponse({ message: 'Bad credentials' }, 401),
    async () => {
      const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, { record: envelope }));
      // 401 is remapped so the dashboard's auth client doesn't interpret
      // an upstream auth failure as a session logout.
      assertEquals(resp.status, 502);
    },
  );

  await withMockedFetch(
    () => jsonResponse({ message: 'boom' }, 500),
    async () => {
      const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, { record: envelope }));
      // Non-auth failures pass through so the operator sees the real code.
      assertEquals(resp.status, 500);
    },
  );
});

// --- Group C: refresh CAS / sibling-rotation recovery ---
//
// Dashboard refresh now delegates to ensureXxxAccessToken(force: true), so
// it inherits the data plane's refresh-race recovery: an `invalid_grant`
// caused by a sibling that already rotated returns success with the
// sibling's fresh access token, while a genuine death (or a sibling
// terminal flip) surfaces the terminal error. These endpoint-level tests
// pin that inherited contract.

test('POST /api/upstreams/codex/oauth/refresh recovers as success when a sibling rotated the refresh token mid-flight', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);
  const siblingExpiresAt = Date.now() + 3_600_000;

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://auth.openai.com/oauth/token') {
        // Plant the sibling's rotation result before answering with
        // invalid_grant, so recoverFromRefreshRace re-reads state and sees
        // a rotated refresh_token + a fresh access token.
        const row = await repo.upstreams.getById(created.id);
        const rowState = row!.state as { accounts: Array<Record<string, unknown>> };
        await repo.upstreams.save({
          ...row!,
          state: {
            accounts: rowState.accounts.map(a => ({
              ...a,
              refresh_token: 'rt_sibling_rotated',
              accessToken: {
                token: 'at_sibling_rotated',
                expiresAt: siblingExpiresAt,
                refreshedAt: new Date().toISOString(),
              },
            })),
          },
        });
        return new Response(
          JSON.stringify({ error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token.' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/codex/oauth/refresh', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; refresh_token: string; accessToken: { token: string; expiresAt: number } | null }> };
  assertEquals(storedState.accounts[0].state, 'active');
  assertEquals(storedState.accounts[0].refresh_token, 'rt_sibling_rotated');
  assertEquals(storedState.accounts[0].accessToken?.token, 'at_sibling_rotated');
});

test('POST /api/upstreams/codex/oauth/refresh surfaces terminal error when a sibling flipped the account to refresh_failed mid-flight', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createCodexUpstreamViaExchange(adminSession);

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://auth.openai.com/oauth/token') {
        // Sibling flipped the account to refresh_failed before our mint
        // resolved. recoverFromRefreshRace re-reads, sees state !== 'active',
        // returns null, and the original invalid_grant propagates.
        const row = await repo.upstreams.getById(created.id);
        const rowState = row!.state as { accounts: Array<Record<string, unknown>> };
        await repo.upstreams.save({
          ...row!,
          state: {
            accounts: rowState.accounts.map(a => ({
              ...a,
              state: 'refresh_failed',
              state_message: 'sibling flipped',
              state_updated_at: new Date().toISOString(),
              accessToken: null,
            })),
          },
        });
        return new Response(
          JSON.stringify({ error: { code: 'invalid_grant', message: 'Refresh token revoked' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/codex/oauth/refresh', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 400);
      const body = (await resp.json()) as { error: string };
      assertEquals(body.error.toLowerCase().includes('re-run oauth'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
});

test('POST /api/upstreams/claude-code/oauth/refresh recovers as success when a sibling rotated the refresh token mid-flight', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);
  const siblingExpiresAt = Date.now() + 3_600_000;

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') {
        // Plant the sibling's rotation before answering with invalid_grant,
        // so recoverFromRefreshRace observes a rotated refreshToken + a
        // fresh accessToken and returns success without a re-mint.
        const row = await repo.upstreams.getById(created.id);
        const rowState = row!.state as { accounts: Array<Record<string, unknown>> };
        await repo.upstreams.save({
          ...row!,
          state: {
            accounts: rowState.accounts.map(a => ({
              ...a,
              refreshToken: 'rt_sibling_rotated',
              accessToken: {
                token: 'at_sibling_rotated',
                expiresAt: siblingExpiresAt,
                refreshedAt: new Date().toISOString(),
              },
            })),
          },
        });
        return new Response(
          JSON.stringify({ error: { code: 'invalid_grant', message: 'Refresh token already used' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; refreshToken: string; accessToken: { token: string } | null }> };
  assertEquals(storedState.accounts[0].state, 'active');
  assertEquals(storedState.accounts[0].refreshToken, 'rt_sibling_rotated');
  assertEquals(storedState.accounts[0].accessToken?.token, 'at_sibling_rotated');
});
