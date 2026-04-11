export interface ApiKey {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface GitHubAccount {
  token: string;
  accountType: string;
  user: {
    login: string;
    avatar_url: string;
    name: string | null;
    id: number;
  };
}

export interface UsageRecord {
  keyId: string;
  model: string;
  hour: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ApiKeyRepo {
  list(): Promise<ApiKey[]>;
  findByRawKey(rawKey: string): Promise<ApiKey | null>;
  getById(id: string): Promise<ApiKey | null>;
  save(key: ApiKey): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface GitHubRepo {
  listAccounts(): Promise<GitHubAccount[]>;
  getAccount(userId: number): Promise<GitHubAccount | null>;
  saveAccount(userId: number, account: GitHubAccount): Promise<void>;
  deleteAccount(userId: number): Promise<void>;
  getActiveId(): Promise<number | null>;
  setActiveId(userId: number): Promise<void>;
  clearActiveId(): Promise<void>;
  deleteAllAccounts(): Promise<void>;
}

export interface UsageRepo {
  record(
    keyId: string,
    model: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
  ): Promise<void>;
  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]>;
  listAll(): Promise<UsageRecord[]>;
  set(record: UsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface CacheRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  cache: CacheRepo;
}
