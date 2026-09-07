import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STATIC_ASSET_CACHE_CONTROL } from '../../platform-node/src/static-web.ts';

// Two hosting topologies serve the client build's hashed assets themselves --
// Workers Static Assets on Cloudflare and the Node static handler in the
// self-host topology. Both default to revalidating every asset on every page
// load, so a topology that silently loses this policy looks correct and is
// merely slow. Reading Cloudflare's policy and Node's constant is what turns
// that into a failing suite.
const repoRoot = resolve(import.meta.dirname, '../../..');
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

// A `_headers` rule block opens with an unindented URL pattern and continues
// with indented `Name: value` lines:
// https://developers.cloudflare.com/workers/static-assets/headers/
const parseHeadersFile = (source: string) => {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of source.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    const [, name, value] = /^\s*([^:]+):\s*(.*)$/.exec(line)!;
    current!.set(name!.toLowerCase(), value!.trim());
  }
  return rules;
};

const headersRules = parseHeadersFile(readRepoFile('apps/web/public/_headers'));

describe('static asset caching', () => {
  it('caches the hashed asset directory for a year in every topology', () => {
    expect({
      wrangler: headersRules.get('/assets/*')?.get('cache-control'),
      node: STATIC_ASSET_CACHE_CONTROL,
    }).toEqual({ wrangler: STATIC_ASSET_CACHE_CONTROL, node: STATIC_ASSET_CACHE_CONTROL });
  });

  // index.html names the current hashes, so it is the document every deploy
  // rewrites. Both topologies leave it on their revalidating default, and a
  // rule reaching beyond /assets/ would be how that is lost.
  it('leaves the unhashed document out of the cached scope', () => {
    expect([...headersRules.keys()]).toEqual(['/assets/*']);
  });

  it('serves sourcemaps as JSON in the Node topology', () => {
    expect(readRepoFile('apps/platform-node/src/static-web.ts')).toMatch(/'\.map': 'application\/json; charset=utf-8'/);
  });
});
