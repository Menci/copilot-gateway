import { serve, upgradeWebSocket } from '@hono/node-server';
import { Agent, Pool, setGlobalDispatcher } from 'undici';
import { WebSocketServer } from 'ws';

// Copilot data-plane hosts close their keep-alive socket right after each
// response; reusing it surfaces as UND_ERR_SOCKET or
// RequestContentLengthMismatchError. `pipelining: 0` disables keep-alive.
//
// The host list is decided by GitHub (returned in /copilot_internal/v2/token
// `endpoints.api`, never enumerated locally), so we match the
// `*.githubcopilot.com` family rather than enumerate today's three
// (individual, business, enterprise) and silently miss any new tier GitHub
// adds.
//
// Refs: https://github.com/nodejs/undici/blob/v6.21.0/docs/docs/api/Client.md#parameter-clientoptions
//       https://github.com/Menci/Floway/pull/78#issuecomment-4765475966
const isCopilotDataPlaneHost = (hostname: string): boolean =>
  hostname === 'githubcopilot.com' || hostname.endsWith('.githubcopilot.com');
setGlobalDispatcher(new Agent({
  factory: (origin, opts) => {
    const hostname = typeof origin === 'string' ? new URL(origin).hostname : origin.hostname;
    return new Pool(origin, isCopilotDataPlaneHost(hostname) ? { ...opts, pipelining: 0 } : opts);
  },
}));

import { bootstrapNodePlatform } from './src/bootstrap.ts';
import { applyMigrations } from './src/migrate.ts';
import { startScheduledMaintenance } from './src/scheduled-maintenance.ts';
import { createNodeFetchHandler, nodeWebDistDir } from './src/static-web.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  initOpenAIResponsesWebSocketUpgradeResolver,
  SqlRepo,
} from '@floway-dev/gateway';
import { getEnvOptional } from '@floway-dev/platform';

// In Node we don't have Workers' executionCtx.waitUntil — there's no request
// lifecycle to attach background work to — so the resolver fire-and-forgets
// the promise. Logging the rejection here is the only signal we get; without
// it a swallowed background failure would be silent.
initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});

initOpenAIResponsesWebSocketUpgradeResolver((c, events) =>
  upgradeWebSocket(c, events, { onError: err => console.error('[websocket]', err) }));

const { db } = bootstrapNodePlatform();
const port = Number(getEnvOptional('PORT', '8788'));
const hostname = String(getEnvOptional('HOST', '127.0.0.1'));
const fetch = createNodeFetchHandler(app.fetch, { distDir: nodeWebDistDir() });

// Passwordless admin login is a dev-only shortcut (empty ADMIN_KEY on a
// local instance grants seed-admin access). Refuse to boot the Node
// target under NODE_ENV=production without ADMIN_KEY so misconfiguration
// surfaces at start, not at first login. The Cloudflare side gates the
// same combination per-request via isProductionRequest.
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_KEY) {
  console.error('FATAL: NODE_ENV=production requires ADMIN_KEY. Passwordless admin login is only allowed on dev instances.');
  process.exit(1);
}

await applyMigrations(db);
initRepo(new SqlRepo(db));

startScheduledMaintenance();

serve({
  fetch,
  hostname,
  port,
  websocket: { server: new WebSocketServer({ noServer: true }) },
}, info => {
  console.log(`Floway listening on http://localhost:${info.port}`);
});
