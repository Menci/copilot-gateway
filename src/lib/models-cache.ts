// Model info cache — periodically refreshes model list from Copilot API
// Used to determine which API path to use (chat/completions, messages, responses)

import { copilotFetch } from "./copilot.ts";
import { getRepo } from "../repo/mod.ts";

export interface ModelInfo {
  id: string;
  name: string;
  version: string;
  object: string;
  capabilities: {
    family: string;
    type: string;
    limits: {
      max_prompt_tokens?: number;
      max_output_tokens?: number;
    };
    supports: {
      tool_calls?: boolean;
      parallel_tool_calls?: boolean;
      streaming?: boolean;
      vision?: boolean;
      adaptive_thinking?: boolean;
    };
  };
  supported_endpoints?: string[];
}

export interface ModelsResponse {
  object: string;
  data: ModelInfo[];
}

interface ModelsCacheEntry {
  fetchedAt: number;
  data: ModelsResponse;
}

// Two-level cache for edge deployments:
// - L1 in-process cache (120s) avoids repeated repo reads on hot isolates.
// - L2 repo-backed cache (600s) keeps model capability routing coherent across datacenters.
let inProcessCache: { cacheKey: string; entry: ModelsCacheEntry } | null = null;
const IN_PROCESS_TTL_MS = 120_000;
const REPO_TTL_MS = 600_000;
const MODELS_CACHE_KEY_PREFIX = "models_cache_v1";

export function clearModelsCache(): void {
  inProcessCache = null;
}

async function modelsCacheKey(githubToken: string, accountType: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${accountType}:${githubToken}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${MODELS_CACHE_KEY_PREFIX}:${hash}`;
}

function isFresh(entry: ModelsCacheEntry, ttlMs: number, now: number): boolean {
  return now - entry.fetchedAt < ttlMs;
}

async function readRepoCache(cacheKey: string): Promise<ModelsCacheEntry | null> {
  try {
    const raw = await getRepo().cache.get(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelsCacheEntry;
    if (typeof parsed?.fetchedAt !== "number" || !parsed.data || !Array.isArray(parsed.data.data)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeRepoCache(cacheKey: string, entry: ModelsCacheEntry): Promise<void> {
  try {
    await getRepo().cache.set(cacheKey, JSON.stringify(entry));
  } catch {
    // Repo cache is an optimization; fetch result is still usable without persisting it.
  }
}

/** Get cached model list, refreshing if stale or token changed */
export async function getModels(
  githubToken: string,
  accountType: string,
): Promise<ModelsResponse> {
  const now = Date.now();
  const cacheKey = await modelsCacheKey(githubToken, accountType);

  if (inProcessCache?.cacheKey === cacheKey && isFresh(inProcessCache.entry, IN_PROCESS_TTL_MS, now)) {
    return inProcessCache.entry.data;
  }

  const repoEntry = await readRepoCache(cacheKey);
  if (repoEntry && isFresh(repoEntry, REPO_TTL_MS, now)) {
    inProcessCache = { cacheKey, entry: repoEntry };
    return repoEntry.data;
  }

  try {
    const resp = await copilotFetch(
      "/models",
      { method: "GET" },
      githubToken,
      accountType,
    );

    if (resp.ok) {
      const entry = {
        fetchedAt: now,
        data: (await resp.json()) as ModelsResponse,
      } satisfies ModelsCacheEntry;
      inProcessCache = { cacheKey, entry };
      await writeRepoCache(cacheKey, entry);
      return entry.data;
    }
  } catch (e) {
    console.warn("Failed to refresh model cache:", e);
  }

  // Return stale repo cache if available.
  if (repoEntry) {
    inProcessCache = { cacheKey, entry: repoEntry };
    return repoEntry.data;
  }

  // Return stale in-process cache for the same key if available.
  if (inProcessCache?.cacheKey === cacheKey) {
    return inProcessCache.entry.data;
  }

  // Fallback empty
  return { object: "list", data: [] };
}

/** Find a specific model by ID */
export async function findModel(
  modelId: string,
  githubToken: string,
  accountType: string,
): Promise<ModelInfo | undefined> {
  const models = await getModels(githubToken, accountType);
  return models.data.find((m) => m.id === modelId);
}

/** Check if a model supports a specific endpoint */
export async function modelSupportsEndpoint(
  modelId: string,
  endpoint: string,
  githubToken: string,
  accountType: string,
): Promise<boolean> {
  const model = await findModel(modelId, githubToken, accountType);
  if (!model?.supported_endpoints) return false;
  return model.supported_endpoints.includes(endpoint);
}
