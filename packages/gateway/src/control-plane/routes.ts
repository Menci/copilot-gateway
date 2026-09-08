import { Hono, type Next } from 'hono';

import { AGENT_SETUP_ROUTE_PATH, agentSetupControlRoutes } from './agent-setup.ts';
import { createKey, deleteKey, listKeys, rotateKey, updateKey } from './api-keys/routes.ts';
import { authLogin, authLogout, authMe } from './auth/routes.ts';
import { exportData, importData } from './data-transfer/routes.ts';
import { dumpRoutes } from './dump.ts';
import { createAlias, deleteAlias, listAliases, updateAlias } from './model-aliases/routes.ts';
import { controlPlaneModels } from './models/routes.ts';
import { performanceOverview } from './performance/routes.ts';
import { createProxy, deleteProxy, listAllBackoffs, listProxies, listProxyBackoffs, resetProxyBackoffs, testProxy, updateProxy } from './proxies/routes.ts';
import { authLoginBody, changeOwnPasswordBody, claudeCodeOAuthAuthorizeUrlBody, claudeCodeOAuthExchangeBody, claudeCodeOAuthRefreshBody, claudeCodeProbeBody, claudeCodeSetupTokenAuthorizeUrlBody, claudeCodeSetupTokenExchangeBody, codexOAuthAuthorizeUrlBody, codexOAuthExchangeBody, codexOAuthRefreshBody, codexRateLimitResetConsumeBody, codexRateLimitResetCreditsBody, copilotOAuthDeviceLoginPollBody, copilotOAuthDeviceLoginStartBody, copilotQuotaBody, createAliasBody, createKeyBody, createProxyBody, createUpstreamBody, createUserBody, exportQuery, importBody, listModelsBody, modelsQuery, ollamaUsageBody, performanceQuery, resetBackoffBody, rotateKeyBody, webSearchConfigSchema, webSearchUsageQuery, testProxyBody, tokenUsageOverviewQuery, tokenUsageQuery, updateAliasBody, updateKeyBody, updateProxyBody, updateUpstreamBody, updateUserBody } from './schemas.ts';
import { getWebSearchConfigRoute, putWebSearchConfigRoute, testWebSearchConfigRoute } from './search-config/routes.ts';
import { webSearchUsage } from './search-usage/routes.ts';
import { tokenUsageOverview } from './token-usage/overview.ts';
import { tokenUsage } from './token-usage/routes.ts';
import { claudeCodeOAuthAuthorizeUrl, claudeCodeOAuthExchange, claudeCodeOAuthRefresh, claudeCodeProbe, claudeCodeSetupTokenAuthorizeUrl, claudeCodeSetupTokenExchange } from './upstreams/claude-code.ts';
import { codexOAuthAuthorizeUrl, codexOAuthExchange, codexOAuthRefresh, codexRateLimitResetConsume, codexRateLimitResetCredits } from './upstreams/codex.ts';
import { copilotOAuthDeviceLoginPoll, copilotOAuthDeviceLoginStart, copilotQuota } from './upstreams/copilot.ts';
import { listModels } from './upstreams/models.ts';
import { ollamaUsage } from './upstreams/ollama.ts';
import { createUpstream, deleteUpstream, getUpstream, getUpstreamBlueprint, listUpstreamOptions, listUpstreams, updateUpstream } from './upstreams/routes.ts';
import { changeOwnPassword, createUser, deleteUser, listUsers, updateUser } from './users/routes.ts';
import { type AuthedContext, type AuthVars, userFromContext } from '../middleware/auth.ts';
import { zValidator } from '../middleware/zod-validator.ts';
import { getRuntimeInfo } from '../runtime/runtime-info.ts';

const adminOnlyMiddleware = async (c: AuthedContext, next: Next) => {
  if (!userFromContext(c).isAdmin) {
    return c.json({ error: 'Admin privileges required' }, 403);
  }
  await next();
};

// Chained route registration is required so Hono flows per-path types into
// the exported `controlPlaneRoutes` type; RPC clients consume it for path/
// method autocomplete and request/response inference. The `Variables` generic
// mirrors `app.ts` so c.set / c.get stay type-checked inside every handler
// registered here (and inside the inner admin-gated sub-app).
export const controlPlaneRoutes = new Hono<{ Variables: AuthVars }>()
  .get('/api/health', c => c.json({ status: 'ok', service: 'floway' }))
  // Quiet 204 to suppress 404 noise from favicon probes; the path is
  // already in PUBLIC_PATHS so auth lets it through.
  .get('/favicon.ico', () => new Response(null, { status: 204 }))
  .post('/auth/login', zValidator('json', authLoginBody), authLogin)
  .post('/auth/logout', authLogout)
  .get('/auth/me', authMe)
  .get('/api/runtime-info', c => c.json(getRuntimeInfo(c.req.raw)))
  .get('/api/keys', listKeys)
  .post('/api/keys', zValidator('json', createKeyBody), createKey)
  .post('/api/keys/:id/rotate', zValidator('json', rotateKeyBody), rotateKey)
  .patch('/api/keys/:id', zValidator('json', updateKeyBody), updateKey)
  .delete('/api/keys/:id', deleteKey)
  .get('/api/token-usage', zValidator('query', tokenUsageQuery), tokenUsage)
  .get('/api/token-usage/overview', zValidator('query', tokenUsageOverviewQuery), tokenUsageOverview)
  .get('/api/search-usage', zValidator('query', webSearchUsageQuery), webSearchUsage)
  .get('/api/performance/overview', zValidator('query', performanceQuery), performanceOverview)
  .get('/api/models', zValidator('query', modelsQuery), controlPlaneModels)
  // Minimal upstream picker exposed to non-admin users so they can scope a key
  // to specific upstreams. Returns id/name/provider/enabled only — no config,
  // no flag overrides, no model lists. Server-side validation (api-keys'
  // `upstream_ids ⊆ user.upstreamIds` check) is the real authorization gate;
  // this endpoint just feeds the picker UI.
  .get('/api/upstream-options', listUpstreamOptions)
  .route('/api/dump', dumpRoutes)
  // Per-user Agent Setup lease control routes (POST / PUT / heartbeat). Not
  // admin-gated. The public GET/HEAD setup-script routes are mounted separately
  // in app.ts, ahead of this middleware chain.
  .route(AGENT_SETUP_ROUTE_PATH, agentSetupControlRoutes)
  // Self-service password change is session-only (the current-password check
  // pairs with a logged-in dashboard session); admins reset other users'
  // passwords through PATCH /api/users/:id below, which is admin-gated.
  .patch('/api/users/me/password', zValidator('json', changeOwnPasswordBody), changeOwnPassword)
  .route('/api', new Hono<{ Variables: AuthVars }>()
    .use('*', adminOnlyMiddleware)
    .get('/users', listUsers)
    .post('/users', zValidator('json', createUserBody), createUser)
    .patch('/users/:id', zValidator('json', updateUserBody), updateUser)
    .delete('/users/:id', deleteUser)
    .get('/upstreams', listUpstreams)
    .get('/upstreams/blueprint', getUpstreamBlueprint)
    .post('/upstreams/copilot/oauth/device-login/start', zValidator('json', copilotOAuthDeviceLoginStartBody), copilotOAuthDeviceLoginStart)
    .post('/upstreams/copilot/oauth/device-login/poll', zValidator('json', copilotOAuthDeviceLoginPollBody), copilotOAuthDeviceLoginPoll)
    .post('/upstreams/copilot/quota', zValidator('json', copilotQuotaBody), copilotQuota)
    .post('/upstreams/codex/oauth/authorize-url', zValidator('json', codexOAuthAuthorizeUrlBody), codexOAuthAuthorizeUrl)
    .post('/upstreams/codex/oauth/exchange', zValidator('json', codexOAuthExchangeBody), codexOAuthExchange)
    .post('/upstreams/codex/oauth/refresh', zValidator('json', codexOAuthRefreshBody), codexOAuthRefresh)
    .post('/upstreams/codex/reset-credits', zValidator('json', codexRateLimitResetCreditsBody), codexRateLimitResetCredits)
    .post('/upstreams/codex/reset-credits/consume', zValidator('json', codexRateLimitResetConsumeBody), codexRateLimitResetConsume)
    .post('/upstreams/claude-code/oauth/authorize-url', zValidator('json', claudeCodeOAuthAuthorizeUrlBody), claudeCodeOAuthAuthorizeUrl)
    .post('/upstreams/claude-code/oauth/exchange', zValidator('json', claudeCodeOAuthExchangeBody), claudeCodeOAuthExchange)
    .post('/upstreams/claude-code/oauth/refresh', zValidator('json', claudeCodeOAuthRefreshBody), claudeCodeOAuthRefresh)
    .post('/upstreams/claude-code/setup-token/authorize-url', zValidator('json', claudeCodeSetupTokenAuthorizeUrlBody), claudeCodeSetupTokenAuthorizeUrl)
    .post('/upstreams/claude-code/setup-token/exchange', zValidator('json', claudeCodeSetupTokenExchangeBody), claudeCodeSetupTokenExchange)
    .post('/upstreams/claude-code/probe', zValidator('json', claudeCodeProbeBody), claudeCodeProbe)
    .post('/upstreams/ollama/usage', zValidator('json', ollamaUsageBody), ollamaUsage)
    .post('/upstreams/list-models', zValidator('json', listModelsBody), listModels)
    .post('/upstreams', zValidator('json', createUpstreamBody), createUpstream)
    .get('/upstreams/:id', getUpstream)
    .patch('/upstreams/:id', zValidator('json', updateUpstreamBody), updateUpstream)
    .delete('/upstreams/:id', deleteUpstream)
    // Proxies. Literal `/proxies/backoffs` is registered before any `/:id`
    // route so Hono matches the literal segment first.
    .get('/proxies', listProxies)
    .get('/proxies/backoffs', listAllBackoffs)
    .post('/proxies', zValidator('json', createProxyBody), createProxy)
    .post('/proxies/test', zValidator('json', testProxyBody), testProxy)
    .post('/proxies/:id/backoffs/reset', zValidator('json', resetBackoffBody), resetProxyBackoffs)
    .get('/proxies/:id/backoffs', listProxyBackoffs)
    .patch('/proxies/:id', zValidator('json', updateProxyBody), updateProxy)
    .delete('/proxies/:id', deleteProxy)
    // Model aliases. Admin-only — alias config is gateway-wide tenant state,
    // and the data-plane resolver runs above prefix routing for every request.
    .get('/aliases', listAliases)
    .post('/aliases', zValidator('json', createAliasBody), createAlias)
    .put('/aliases/:id', zValidator('json', updateAliasBody), updateAlias)
    .delete('/aliases/:id', deleteAlias)
    .get('/search-config', getWebSearchConfigRoute)
    .put('/search-config', zValidator('json', webSearchConfigSchema), putWebSearchConfigRoute)
    .post('/search-config/test', zValidator('json', webSearchConfigSchema), testWebSearchConfigRoute)
    .get('/export', zValidator('query', exportQuery), exportData)
    .post('/import', zValidator('json', importBody), importData));
