// In-memory repository implementation for testing

import type {
  ApiKey,
  ApiKeyRepo,
  GitHubAccount,
  GitHubRepo,
  Repo,
  UsageRecord,
  UsageRepo,
} from "./types.ts";

class MemoryApiKeyRepo implements ApiKeyRepo {
  private store = new Map<string, ApiKey>();

  async list(): Promise<ApiKey[]> {
    return [...this.store.values()];
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    for (const key of this.store.values()) {
      if (key.key === rawKey) return key;
    }
    return null;
  }

  async getById(id: string): Promise<ApiKey | null> {
    return this.store.get(id) ?? null;
  }

  async save(key: ApiKey): Promise<void> {
    this.store.set(key.id, { ...key });
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async deleteAll(): Promise<void> {
    this.store.clear();
  }
}

class MemoryGitHubRepo implements GitHubRepo {
  private accounts = new Map<number, GitHubAccount>();
  private activeId: number | null = null;

  async listAccounts(): Promise<GitHubAccount[]> {
    return [...this.accounts.values()];
  }

  async getAccount(userId: number): Promise<GitHubAccount | null> {
    return this.accounts.get(userId) ?? null;
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    this.accounts.set(userId, { ...account, user: { ...account.user } });
  }

  async deleteAccount(userId: number): Promise<void> {
    this.accounts.delete(userId);
    if (this.activeId === userId) this.activeId = null;
  }

  async getActiveId(): Promise<number | null> {
    return this.activeId;
  }

  async setActiveId(userId: number): Promise<void> {
    this.activeId = userId;
  }

  async clearActiveId(): Promise<void> {
    this.activeId = null;
  }

  async deleteAllAccounts(): Promise<void> {
    this.accounts.clear();
    this.activeId = null;
  }
}

class MemoryUsageRepo implements UsageRepo {
  private store = new Map<string, UsageRecord>();

  private key(r: { keyId: string; model: string; hour: string }): string {
    return `${r.keyId}\0${r.model}\0${r.hour}`;
  }

  async record(
    keyId: string,
    model: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    const k = this.key({ keyId, model, hour });
    const existing = this.store.get(k);
    if (existing) {
      existing.requests += requests;
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
    } else {
      this.store.set(k, { keyId, model, hour, requests, inputTokens, outputTokens });
    }
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    return [...this.store.values()]
      .filter((r) => {
        if (opts.keyId && r.keyId !== opts.keyId) return false;
        return r.hour >= opts.start && r.hour < opts.end;
      })
      .sort((a, b) => a.hour.localeCompare(b.hour));
  }

  async listAll(): Promise<UsageRecord[]> {
    return [...this.store.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  async set(record: UsageRecord): Promise<void> {
    this.store.set(this.key(record), { ...record });
  }

  async deleteAll(): Promise<void> {
    this.store.clear();
  }
}

export class InMemoryRepo implements Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;

  constructor() {
    this.apiKeys = new MemoryApiKeyRepo();
    this.github = new MemoryGitHubRepo();
    this.usage = new MemoryUsageRepo();
  }
}
