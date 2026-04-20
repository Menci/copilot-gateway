// GET /api/token-usage — query per-key token usage records
//
// Admin users can view all keys or filter by key_id.
// API key users are scoped to their own key only.

import type { Context } from "hono";
import { queryUsage } from "../lib/usage-tracker.ts";
import { listApiKeys } from "../lib/api-keys.ts";

export const tokenUsage = async (c: Context) => {
  const isAdmin: boolean = c.get("isAdmin") ?? false;
  const apiKeyId: string | undefined = c.get("apiKeyId");
  const keyId = isAdmin ? (c.req.query("key_id") || undefined) : apiKeyId;
  const start = c.req.query("start") ?? "";
  const end = c.req.query("end") ?? "";

  if (!start || !end) {
    return c.json({ error: "start and end query parameters are required (e.g. 2026-03-09T00)" }, 400);
  }

  const [records, keys] = await Promise.all([
    queryUsage({ keyId, start, end }),
    listApiKeys(),
  ]);

  const nameMap = new Map(keys.map((k) => [k.id, k.name]));
  return c.json(records.map((r) => ({
    ...r,
    keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8),
  })));
};
