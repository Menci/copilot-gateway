// In-memory repository implementation for testing

import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  GitHubAccount,
  GitHubRepo,
  Repo,
  UsageRecord,
  UsageRepo,
} from "./types.ts";

class MemoryApiKeyRepo implements ApiKeyRepo {
  private store = new Map<string, ApiKey>();

  list(): Promise<ApiKey[]> {
    return Promise.resolve([...this.store.values()]);
  }

  findByRawKey(rawKey: string): Promise<ApiKey | null> {
    for (const key of this.store.values()) {
      if (key.key === rawKey) return Promise.resolve(key);
    }
    return Promise.resolve(null);
  }

  getById(id: string): Promise<ApiKey | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  save(key: ApiKey): Promise<void> {
    this.store.set(key.id, { ...key });
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(id));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemoryGitHubRepo implements GitHubRepo {
  private accounts = new Map<number, GitHubAccount>();
  private activeId: number | null = null;

  listAccounts(): Promise<GitHubAccount[]> {
    return Promise.resolve([...this.accounts.values()]);
  }

  getAccount(userId: number): Promise<GitHubAccount | null> {
    return Promise.resolve(this.accounts.get(userId) ?? null);
  }

  saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    this.accounts.set(userId, { ...account, user: { ...account.user } });
    return Promise.resolve();
  }

  deleteAccount(userId: number): Promise<void> {
    this.accounts.delete(userId);
    if (this.activeId === userId) this.activeId = null;
    return Promise.resolve();
  }

  getActiveId(): Promise<number | null> {
    return Promise.resolve(this.activeId);
  }

  setActiveId(userId: number): Promise<void> {
    this.activeId = userId;
    return Promise.resolve();
  }

  clearActiveId(): Promise<void> {
    this.activeId = null;
    return Promise.resolve();
  }

  deleteAllAccounts(): Promise<void> {
    this.accounts.clear();
    this.activeId = null;
    return Promise.resolve();
  }
}

class MemoryUsageRepo implements UsageRepo {
  private store = new Map<string, UsageRecord>();

  private key(r: { keyId: string; model: string; hour: string }): string {
    return `${r.keyId}\0${r.model}\0${r.hour}`;
  }

  record(
    keyId: string,
    model: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): Promise<void> {
    const k = this.key({ keyId, model, hour });
    const existing = this.store.get(k);
    if (existing) {
      existing.requests += requests;
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.cacheReadTokens += cacheReadTokens;
      existing.cacheCreationTokens += cacheCreationTokens;
    } else {
      this.store.set(k, { keyId, model, hour, requests, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens });
    }
    return Promise.resolve();
  }

  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    return Promise.resolve(
      [...this.store.values()]
        .filter((r) => {
          if (opts.keyId && r.keyId !== opts.keyId) return false;
          return r.hour >= opts.start && r.hour < opts.end;
        })
        .sort((a, b) => a.hour.localeCompare(b.hour)),
    );
  }

  listAll(): Promise<UsageRecord[]> {
    return Promise.resolve([...this.store.values()].sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  set(record: UsageRecord): Promise<void> {
    this.store.set(this.key(record), { ...record });
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemoryCacheRepo implements CacheRepo {
  private store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

export class InMemoryRepo implements Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  cache: CacheRepo;

  constructor() {
    this.apiKeys = new MemoryApiKeyRepo();
    this.github = new MemoryGitHubRepo();
    this.usage = new MemoryUsageRepo();
    this.cache = new MemoryCacheRepo();
  }
}
