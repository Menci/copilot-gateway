// API key management routes

import type { Context } from "hono";
import { createApiKey, listApiKeys, deleteApiKey, rotateApiKey, renameApiKey, type ApiKey } from "../lib/api-keys.ts";

function keyToJson(k: ApiKey) {
  return { id: k.id, name: k.name, key: k.key, created_at: k.createdAt, last_used_at: k.lastUsedAt ?? null };
}

export const listKeys = (_c: Context) => {
  return listApiKeys().then((keys) => {
    return _c.json(keys.map((k) => keyToJson(k)));
  });
};

export const createKey = async (c: Context) => {
  const body = await c.req.json<{ name?: string }>();
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }

  const key = await createApiKey(body.name);
  return c.json(keyToJson(key), 201);
};

export const deleteKey = async (c: Context) => {
  const id = c.req.param("id") ?? "";
  const deleted = await deleteApiKey(id);
  if (!deleted) return c.json({ error: "Key not found" }, 404);
  return c.json({ ok: true });
};

export const rotateKey = async (c: Context) => {
  const id = c.req.param("id") ?? "";
  const key = await rotateApiKey(id);
  if (!key) return c.json({ error: "Key not found" }, 404);
  return c.json(keyToJson(key));
};

export const renameKey = async (c: Context) => {
  const id = c.req.param("id") ?? "";
  const body = await c.req.json<{ name?: string }>();
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }

  const key = await renameApiKey(id, body.name);
  if (!key) return c.json({ error: "Key not found" }, 404);
  return c.json(keyToJson(key));
};
