// Data transfer routes — export/import all database data as JSON

import type { Context } from "hono";
import { getRepo } from "../repo/mod.ts";
import type { ApiKey, GitHubAccount, UsageRecord } from "../repo/types.ts";

interface ExportPayload {
  version: 1;
  exportedAt: string;
  data: {
    apiKeys: ApiKey[];
    githubAccounts: GitHubAccount[];
    activeGithubAccountId: number | null;
    usage: UsageRecord[];
  };
}

/** GET /api/export — dump all data as JSON */
export const exportData = async (c: Context) => {
  const repo = getRepo();

  const [apiKeys, githubAccounts, activeGithubAccountId, usage] =
    await Promise.all([
      repo.apiKeys.list(),
      repo.github.listAccounts(),
      repo.github.getActiveId(),
      repo.usage.listAll(),
    ]);

  const payload: ExportPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: { apiKeys, githubAccounts, activeGithubAccountId, usage },
  };

  return c.json(payload);
};

/** POST /api/import — import data with merge or replace mode */
export const importData = async (c: Context) => {
  // deno-lint-ignore no-explicit-any
  const body = await c.req.json<{ mode: string; data: any }>();
  const { mode, data } = body;

  if (mode !== "merge" && mode !== "replace") {
    return c.json({ error: "mode must be 'merge' or 'replace'" }, 400);
  }
  if (!data || typeof data !== "object") {
    return c.json({ error: "data is required" }, 400);
  }

  const repo = getRepo();
  const apiKeys: ApiKey[] = Array.isArray(data.apiKeys) ? data.apiKeys : [];
  const githubAccounts: GitHubAccount[] = Array.isArray(data.githubAccounts) ? data.githubAccounts : [];
  const usage: UsageRecord[] = Array.isArray(data.usage) ? data.usage : [];
  const activeId: number | null = typeof data.activeGithubAccountId === "number" ? data.activeGithubAccountId : null;

  if (mode === "replace") {
    await Promise.all([
      repo.apiKeys.deleteAll(),
      repo.github.deleteAllAccounts(),
      repo.usage.deleteAll(),
    ]);
  }

  // Import API keys
  for (const key of apiKeys) {
    await repo.apiKeys.save(key);
  }

  // Import GitHub accounts
  for (const account of githubAccounts) {
    await repo.github.saveAccount(account.user.id, account);
  }

  // Import usage records
  for (const record of usage) {
    await repo.usage.set(record);
  }

  // Set active GitHub account
  if (activeId != null) {
    if (mode === "replace") {
      await repo.github.setActiveId(activeId);
    } else {
      // Merge: only set if currently unset
      const current = await repo.github.getActiveId();
      if (current == null) {
        await repo.github.setActiveId(activeId);
      }
    }
  }

  return c.json({
    ok: true,
    imported: {
      apiKeys: apiKeys.length,
      githubAccounts: githubAccounts.length,
      usage: usage.length,
    },
  });
};
