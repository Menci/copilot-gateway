import type { Context } from "hono";
import {
  loadSearchConfig,
  normalizeSearchConfig,
  saveSearchConfig,
} from "../../data-plane/tools/web-search/search-config.ts";
import { testSearchConfigConnection } from "../../data-plane/tools/web-search/provider.ts";

export const getSearchConfigRoute = async (c: Context) =>
  c.json(await loadSearchConfig());

export const putSearchConfigRoute = async (c: Context) => {
  const body: unknown = await c.req.json();
  const config = await saveSearchConfig(body);
  return c.json(config);
};

export const testSearchConfigRoute = async (c: Context) => {
  const body: unknown = await c.req.json();
  const result = await testSearchConfigConnection(normalizeSearchConfig(body));
  return c.json(result, result.ok ? 200 : 400);
};
