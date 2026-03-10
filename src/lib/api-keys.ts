import { getRepo } from "../repo/mod.ts";
export type { ApiKey } from "../repo/types.ts";

function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createApiKey(name: string) {
  const key = {
    id: crypto.randomUUID(),
    name,
    key: generateKey(),
    createdAt: new Date().toISOString(),
  };
  await getRepo().apiKeys.save(key);
  return key;
}

export function listApiKeys() {
  return getRepo().apiKeys.list();
}

export function getApiKeyById(id: string) {
  return getRepo().apiKeys.getById(id);
}

export async function renameApiKey(id: string, name: string) {
  const existing = await getRepo().apiKeys.getById(id);
  if (!existing) return null;
  const updated = { ...existing, name };
  await getRepo().apiKeys.save(updated);
  return updated;
}

export async function rotateApiKey(id: string) {
  const existing = await getRepo().apiKeys.getById(id);
  if (!existing) return null;
  const updated = { ...existing, key: generateKey() };
  await getRepo().apiKeys.save(updated);
  return updated;
}

export function deleteApiKey(id: string) {
  return getRepo().apiKeys.delete(id);
}

export async function validateApiKey(rawKey: string) {
  const key = await getRepo().apiKeys.findByRawKey(rawKey);
  if (!key) return null;
  return { id: key.id, name: key.name };
}

export async function touchApiKeyLastUsed(id: string): Promise<void> {
  const existing = await getRepo().apiKeys.getById(id);
  if (!existing) return;
  await getRepo().apiKeys.save({
    ...existing,
    lastUsedAt: new Date().toISOString(),
  });
}
