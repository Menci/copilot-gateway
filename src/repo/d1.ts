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

// Minimal D1 type definitions (subset of @cloudflare/workers-types)
interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

class D1ApiKeyRepo implements ApiKeyRepo {
  constructor(private db: D1Database) {}

  async list(): Promise<ApiKey[]> {
    const { results } = await this.db
      .prepare("SELECT id, name, key, created_at, last_used_at FROM api_keys ORDER BY created_at")
      .all<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null }>();
    return results.map(toApiKey);
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = await this.db
      .prepare("SELECT id, name, key, created_at, last_used_at FROM api_keys WHERE key = ?")
      .bind(rawKey)
      .first<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null }>();
    return row ? toApiKey(row) : null;
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = await this.db
      .prepare("SELECT id, name, key, created_at, last_used_at FROM api_keys WHERE id = ?")
      .bind(id)
      .first<{ id: string; name: string; key: string; created_at: string; last_used_at: string | null }>();
    return row ? toApiKey(row) : null;
  }

  async save(key: ApiKey): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at`,
      )
      .bind(key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null)
      .run();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
    return (result.meta.changes as number ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM api_keys").run();
  }
}

function toApiKey(row: { id: string; name: string; key: string; created_at: string; last_used_at: string | null }): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

class D1GitHubRepo implements GitHubRepo {
  constructor(private db: D1Database) {}

  async listAccounts(): Promise<GitHubAccount[]> {
    const { results } = await this.db
      .prepare("SELECT user_id, token, account_type, login, name, avatar_url FROM github_accounts")
      .all<{ user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string }>();
    return results.map(toGitHubAccount);
  }

  async getAccount(userId: number): Promise<GitHubAccount | null> {
    const row = await this.db
      .prepare("SELECT user_id, token, account_type, login, name, avatar_url FROM github_accounts WHERE user_id = ?")
      .bind(userId)
      .first<{ user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string }>();
    return row ? toGitHubAccount(row) : null;
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO github_accounts (user_id, token, account_type, login, name, avatar_url) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, account_type = excluded.account_type, login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
      )
      .bind(userId, account.token, account.accountType, account.user.login, account.user.name, account.user.avatar_url)
      .run();
  }

  async deleteAccount(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM github_accounts WHERE user_id = ?").bind(userId).run();
  }

  async getActiveId(): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT value FROM config WHERE key = 'active_github_account'")
      .first<{ value: string }>();
    return row ? Number(row.value) : null;
  }

  async setActiveId(userId: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES ('active_github_account', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(String(userId))
      .run();
  }

  async clearActiveId(): Promise<void> {
    await this.db.prepare("DELETE FROM config WHERE key = 'active_github_account'").run();
  }

  async deleteAllAccounts(): Promise<void> {
    await this.db.prepare("DELETE FROM github_accounts").run();
    await this.db.prepare("DELETE FROM config WHERE key = 'active_github_account'").run();
  }
}

function toGitHubAccount(row: { user_id: number; token: string; account_type: string; login: string; name: string | null; avatar_url: string }): GitHubAccount {
  return {
    token: row.token,
    accountType: row.account_type,
    user: {
      id: row.user_id,
      login: row.login,
      name: row.name,
      avatar_url: row.avatar_url,
    },
  };
}

class D1UsageRepo implements UsageRepo {
  constructor(private db: D1Database) {}

  async record(
    keyId: string,
    model: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage (key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour) DO UPDATE SET
           requests = requests + excluded.requests,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens`,
      )
      .bind(keyId, model, hour, requests, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)
      .run();
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    const sql = opts.keyId
      ? "SELECT key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour"
      : "SELECT key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE hour >= ? AND hour < ? ORDER BY hour";
    const binds = opts.keyId ? [opts.keyId, opts.start, opts.end] : [opts.start, opts.end];
    const { results } = await this.db
      .prepare(sql)
      .bind(...binds)
      .all<{ key_id: string; model: string; hour: string; requests: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }>();
    return results.map((r) => ({
      keyId: r.key_id,
      model: r.model,
      hour: r.hour,
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens ?? 0,
      cacheCreationTokens: r.cache_creation_tokens ?? 0,
    }));
  }

  async listAll(): Promise<UsageRecord[]> {
    const { results } = await this.db
      .prepare("SELECT key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage ORDER BY hour")
      .all<{ key_id: string; model: string; hour: string; requests: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }>();
    return results.map((r) => ({
      keyId: r.key_id,
      model: r.model,
      hour: r.hour,
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens ?? 0,
      cacheCreationTokens: r.cache_creation_tokens ?? 0,
    }));
  }

  async set(record: UsageRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage (key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour) DO UPDATE SET
           requests = excluded.requests,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_creation_tokens = excluded.cache_creation_tokens`,
      )
      .bind(record.keyId, record.model, record.hour, record.requests, record.inputTokens, record.outputTokens, record.cacheReadTokens || 0, record.cacheCreationTokens || 0)
      .run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM usage").run();
  }
}

class D1CacheRepo implements CacheRepo {
  constructor(private db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM config WHERE key = ?").bind(key).run();
  }
}

export class D1Repo implements Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  cache: CacheRepo;

  constructor(db: D1Database) {
    this.apiKeys = new D1ApiKeyRepo(db);
    this.github = new D1GitHubRepo(db);
    this.usage = new D1UsageRepo(db);
    this.cache = new D1CacheRepo(db);
  }
}
