import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { createNodeFetchHandler, nodeWebDistDir, STATIC_ASSET_CACHE_CONTROL } from '../src/static-web.ts';

const directories: string[] = [];

const gatewayUrls = [
  '/api/upstreams',
  '/auth/login',
  '/favicon.ico',
  '/v1/chat/completions',
  '/v2/rerank',
  '/v1beta/models/gemini-2.5-pro:generateContent',
  '/jina/v1/rerank',
  '/voyage/v1/rerank',
  '/azure-api.codex/responses',
  '/alpha/search',
  '/responses/compact',
  '/messages/count_tokens',
  '/images/generations',
];

const makeDist = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'floway-node-web-'));
  directories.push(dir);
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Floway</title>');
  await writeFile(join(dir, 'app.js'), 'console.log("app")');
  await writeFile(join(dir, 'assets', 'font.ttf'), 'font');
  await writeFile(join(dir, 'LICENSE'), 'MIT License');
  await writeFile(join(dir, 'robots.txt'), 'User-agent: *');
  return dir;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('serves static assets and falls back to the SPA for a dashboard route', async () => {
  const fetch = createNodeFetchHandler(async () => new Response('gateway'), { distDir: await makeDist() });

  const asset = await fetch(new Request('http://floway.test/app.js'));
  expect(asset.status).toBe(200);
  expect(asset.headers.get('content-type')).toContain('text/javascript');
  expect(await asset.text()).toBe('console.log("app")');

  const page = await fetch(new Request('http://floway.test/dashboard/upstreams'));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<title>Floway</title>');
});

test('preserves static content types and supports conditional revalidation', async () => {
  const fetch = createNodeFetchHandler(async () => new Response('gateway'), { distDir: await makeDist() });

  const font = await fetch(new Request('http://floway.test/assets/font.ttf'));
  expect(font.headers.get('content-type')).toBe('font/ttf');
  expect(font.headers.get('cache-control')).toBe(STATIC_ASSET_CACHE_CONTROL);
  expect(await font.text()).toBe('font');

  const robots = await fetch(new Request('http://floway.test/robots.txt'));
  expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(robots.headers.get('cache-control')).toBe('no-cache');
  expect(robots.headers.get('etag')).toBeTruthy();
  expect(robots.headers.get('last-modified')).toBeTruthy();

  const notModified = await fetch(new Request('http://floway.test/robots.txt', {
    headers: { 'if-none-match': robots.headers.get('etag')! },
  }));
  expect(notModified.status).toBe(304);
  expect(await notModified.text()).toBe('');

  const head = await fetch(new Request('http://floway.test/robots.txt', { method: 'HEAD' }));
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(String('User-agent: *'.length));
  expect(await head.text()).toBe('');

  const license = await fetch(new Request('http://floway.test/LICENSE'));
  expect(license.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(await license.text()).toBe('MIT License');
});

test('preserves gateway 404s and never falls back for missing assets', async () => {
  const fetch = createNodeFetchHandler(async () => new Response('gateway 404', { status: 404 }), { distDir: await makeDist() });

  const api = await fetch(new Request('http://floway.test/api/not-a-route'));
  expect(api.status).toBe(404);
  expect(await api.text()).toBe('gateway 404');

  const apiRoot = await fetch(new Request('http://floway.test/api'));
  expect(apiRoot.status).toBe(404);
  expect(await apiRoot.text()).toBe('gateway 404');

  const favicon = await fetch(new Request('http://floway.test/favicon.ico'));
  expect(favicon.status).toBe(404);
  expect(await favicon.text()).toBe('gateway 404');

  const asset = await fetch(new Request('http://floway.test/assets/missing.js'));
  expect(asset.status).toBe(404);

  const dottedRoute = await fetch(new Request('http://floway.test/dashboard/release-1.0'));
  expect(dottedRoute.status).toBe(200);
  expect(await dottedRoute.text()).toContain('<title>Floway</title>');

  const traversal = await fetch(new Request('http://floway.test/%2e%2e%2foutside'));
  expect(traversal.status).toBe(404);
});

test.each(gatewayUrls)('forwards the gateway-owned path %s instead of the SPA fallback', async pathname => {
  const fetch = createNodeFetchHandler(async () => new Response('gateway'), { distDir: await makeDist() });
  const response = await fetch(new Request(`http://floway.test${pathname}`));
  expect(await response.text()).toBe('gateway');
});

test('forwards the Node adapter context to gateway paths', async () => {
  const env = { websocket: Symbol('websocket') };
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  let receivedEnv: object | undefined;
  let receivedExecutionCtx: unknown;
  const fetch = createNodeFetchHandler((_request, gatewayEnv, gatewayExecutionCtx) => {
    receivedEnv = gatewayEnv;
    receivedExecutionCtx = gatewayExecutionCtx;
    return new Response('gateway');
  }, { distDir: await makeDist() });

  await fetch(new Request('http://floway.test/azure-api.codex/responses', {
    headers: { upgrade: 'websocket' },
  }), env, executionCtx);

  expect(receivedEnv).toBe(env);
  expect(receivedExecutionCtx).toBe(executionCtx);
});

test('returns an actionable error until the web bundle exists', async () => {
  const fetch = createNodeFetchHandler(async () => new Response('gateway'), { distDir: join(tmpdir(), 'floway-missing-web-dist') });
  const response = await fetch(new Request('http://floway.test/login'));
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('pnpm run build:web');
});

test('locates the default web bundle independently of the launch directory', () => {
  expect(nodeWebDistDir()).toMatch(/[/\\]apps[/\\]web[/\\]dist[/\\]client[/\\]?$/);
  expect(nodeWebDistDir({ FLOWAY_WEB_DIST_DIR: '/tmp/custom-dashboard' })).toBe('/tmp/custom-dashboard');
});
