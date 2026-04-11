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

class DenoKvApiKeyRepo implements ApiKeyRepo {
  constructor(private kv: Deno.Kv) {}

  async list(): Promise<ApiKey[]> {
    const keys: ApiKey[] = [];
    for await (const entry of this.kv.list<ApiKey>({ prefix: ["api_keys"] })) {
      keys.push(entry.value);
    }
    return keys;
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    // Fast path: reverse index lookup
    const ref = await this.kv.get<string>(["api_keys_by_key", rawKey]);
    if (ref.value) return this.getById(ref.value);

    // Slow path: scan all keys (handles keys saved before reverse index existed)
    for await (const entry of this.kv.list<ApiKey>({ prefix: ["api_keys"] })) {
      if (entry.value.key === rawKey) {
        // Lazily backfill the reverse index
        await this.kv.set(["api_keys_by_key", rawKey], entry.value.id);
        return entry.value;
      }
    }
    return null;
  }

  async getById(id: string): Promise<ApiKey | null> {
    const entry = await this.kv.get<ApiKey>(["api_keys", id]);
    return entry.value;
  }

  async save(key: ApiKey): Promise<void> {
    const existing = await this.kv.get<ApiKey>(["api_keys", key.id]);
    const ops = this.kv.atomic().set(["api_keys", key.id], key).set(["api_keys_by_key", key.key], key.id);
    if (existing.value && existing.value.key !== key.key) {
      ops.delete(["api_keys_by_key", existing.value.key]);
    }
    await ops.commit();
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.kv.get<ApiKey>(["api_keys", id]);
    if (!existing.value) return false;
    await this.kv.atomic()
      .delete(["api_keys", id])
      .delete(["api_keys_by_key", existing.value.key])
      .commit();
    return true;
  }

  async deleteAll(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["api_keys"] })) {
      await this.kv.delete(entry.key);
    }
    for await (const entry of this.kv.list({ prefix: ["api_keys_by_key"] })) {
      await this.kv.delete(entry.key);
    }
  }
}

class DenoKvGitHubRepo implements GitHubRepo {
  constructor(private kv: Deno.Kv) {}

  async listAccounts(): Promise<GitHubAccount[]> {
    const accounts: GitHubAccount[] = [];
    for await (
      const entry of this.kv.list<GitHubAccount>({
        prefix: ["github_accounts"],
      })
    ) {
      if (entry.value) accounts.push(withDefaultAccountType(entry.value));
    }
    return accounts;
  }

  async getAccount(userId: number): Promise<GitHubAccount | null> {
    const entry = await this.kv.get<GitHubAccount>([
      "github_accounts",
      userId,
    ]);
    return entry.value ? withDefaultAccountType(entry.value) : null;
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    await this.kv.set(["github_accounts", userId], account);
  }

  async deleteAccount(userId: number): Promise<void> {
    await this.kv.delete(["github_accounts", userId]);
  }

  async getActiveId(): Promise<number | null> {
    const entry = await this.kv.get<number>([
      "config",
      "active_github_account",
    ]);
    return entry.value;
  }

  async setActiveId(userId: number): Promise<void> {
    await this.kv.set(["config", "active_github_account"], userId);
  }

  async clearActiveId(): Promise<void> {
    await this.kv.delete(["config", "active_github_account"]);
  }

  async deleteAllAccounts(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["github_accounts"] })) {
      await this.kv.delete(entry.key);
    }
    await this.kv.delete(["config", "active_github_account"]);
  }
}

// KV entries created before accountType was added may lack the field
function withDefaultAccountType(account: GitHubAccount): GitHubAccount {
  return account.accountType ? account : { ...account, accountType: "individual" };
}

class DenoKvUsageRepo implements UsageRepo {
  constructor(private kv: Deno.Kv) {}

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
    let op = this.kv.atomic()
      .sum(["usage", keyId, model, hour, "r"], BigInt(requests))
      .sum(["usage", keyId, model, hour, "i"], BigInt(inputTokens))
      .sum(["usage", keyId, model, hour, "o"], BigInt(outputTokens));
    if (cacheReadTokens > 0) {
      op = op.sum(["usage", keyId, model, hour, "cr"], BigInt(cacheReadTokens));
    }
    if (cacheCreationTokens > 0) {
      op = op.sum(["usage", keyId, model, hour, "cc"], BigInt(cacheCreationTokens));
    }
    await op.commit();
  }

  async query(
    opts: { keyId?: string; start: string; end: string },
  ): Promise<UsageRecord[]> {
    const prefix: Deno.KvKey = opts.keyId
      ? ["usage", opts.keyId]
      : ["usage"];
    const map = new Map<string, UsageRecord>();

    for await (const entry of this.kv.list<Deno.KvU64>({ prefix })) {
      const keyId = entry.key[1] as string;
      const model = entry.key[2] as string;
      const hour = entry.key[3] as string;
      const metric = entry.key[4] as string;
      if (hour < opts.start || hour >= opts.end) continue;

      const mapKey = `${keyId}\0${model}\0${hour}`;
      let rec = map.get(mapKey);
      if (!rec) {
        rec = {
          keyId,
          model,
          hour,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        map.set(mapKey, rec);
      }

      const val = Number(entry.value);
      if (metric === "r") rec.requests = val;
      else if (metric === "i") rec.inputTokens = val;
      else if (metric === "o") rec.outputTokens = val;
      else if (metric === "cr") rec.cacheReadTokens = val;
      else if (metric === "cc") rec.cacheCreationTokens = val;
    }

    return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  async listAll(): Promise<UsageRecord[]> {
    const map = new Map<string, UsageRecord>();
    for await (const entry of this.kv.list<Deno.KvU64>({ prefix: ["usage"] })) {
      const keyId = entry.key[1] as string;
      const model = entry.key[2] as string;
      const hour = entry.key[3] as string;
      const metric = entry.key[4] as string;

      const mapKey = `${keyId}\0${model}\0${hour}`;
      let rec = map.get(mapKey);
      if (!rec) {
        rec = { keyId, model, hour, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
        map.set(mapKey, rec);
      }

      const val = Number(entry.value);
      if (metric === "r") rec.requests = val;
      else if (metric === "i") rec.inputTokens = val;
      else if (metric === "o") rec.outputTokens = val;
      else if (metric === "cr") rec.cacheReadTokens = val;
      else if (metric === "cc") rec.cacheCreationTokens = val;
    }
    return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  async set(record: UsageRecord): Promise<void> {
    await this.kv.set(["usage", record.keyId, record.model, record.hour, "r"], new Deno.KvU64(BigInt(record.requests)));
    await this.kv.set(["usage", record.keyId, record.model, record.hour, "i"], new Deno.KvU64(BigInt(record.inputTokens)));
    await this.kv.set(["usage", record.keyId, record.model, record.hour, "o"], new Deno.KvU64(BigInt(record.outputTokens)));
    await this.kv.set(["usage", record.keyId, record.model, record.hour, "cr"], new Deno.KvU64(BigInt(record.cacheReadTokens || 0)));
    await this.kv.set(["usage", record.keyId, record.model, record.hour, "cc"], new Deno.KvU64(BigInt(record.cacheCreationTokens || 0)));
  }

  async deleteAll(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["usage"] })) {
      await this.kv.delete(entry.key);
    }
  }
}

class DenoKvCacheRepo implements CacheRepo {
  constructor(private kv: Deno.Kv) {}

  async get(key: string): Promise<string | null> {
    const entry = await this.kv.get<string>(["cache", key]);
    return entry.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.kv.set(["cache", key], value);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(["cache", key]);
  }
}

export class DenoKvRepo implements Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  cache: CacheRepo;

  constructor(kv: Deno.Kv) {
    this.apiKeys = new DenoKvApiKeyRepo(kv);
    this.github = new DenoKvGitHubRepo(kv);
    this.usage = new DenoKvUsageRepo(kv);
    this.cache = new DenoKvCacheRepo(kv);
  }
}
