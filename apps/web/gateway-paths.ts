// Every path the gateway owns. Whatever serves the SPA has to divert these to
// the gateway rather than answer them with the SPA fallback, so the same set is
// restated once per hosting topology, each in that topology's own syntax:
//
//   - Here, as `server.proxy` prefixes for the `vite dev` + `wrangler dev` pair.
//   - In `apps/platform-node/src/static-web.ts`, as the Node self-hosted
//     dashboard matcher.
//   - As `assets.run_worker_first` in wrangler.example.jsonc, for production on
//     Cloudflare, where Workers Static Assets serves the SPA.
//
// Drift is silent and surfaces only as a 404 the SPA fallback served for a real
// gateway endpoint, so `__tests__/gateway-paths_test.ts` replays the public
// data-plane route table through all three and fails when any stops covering it.
//
// Bare data-plane paths are listed because the gateway accepts both root and
// `/v1` forms where the upstream protocol defines them.
export const wranglerProxiedPaths = [
  '/api',
  '/auth',
  '/favicon.ico',
  '/v1',
  '/v2',
  '/v1beta',
  '/jina',
  '/voyage',
  '/azure-api.codex',
  '/alpha/search',
  '/completions',
  '/chat/completions',
  '/responses',
  '/messages',
  '/embeddings',
  '/models',
  '/images/generations',
  '/images/edits',
];
