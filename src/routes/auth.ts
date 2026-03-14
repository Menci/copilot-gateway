// Auth routes — ADMIN_KEY validation + GitHub Device Flow OAuth (multi-account)
// Supports login with ADMIN_KEY (full dashboard access) or API key (restricted)
// No sessions, no cookies. All auth via key in every request.

import type { Context } from "hono";
import {
  listGithubAccounts,
  addGithubAccount,
  removeGithubAccount,
  setActiveGithubAccount,
  getActiveGithubAccount,
  type GitHubUser,
} from "../lib/github.ts";
import { clearCopilotTokenCache, githubHeaders } from "../lib/copilot.ts";
import { getEnv } from "../lib/env.ts";
import { validateApiKey } from "../lib/api-keys.ts";
import { clearModelsCache } from "../lib/models-cache.ts";

// GitHub OAuth app client ID (same as Copilot extension)
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_SCOPES = "read:user";

/** POST /auth/login — validate ADMIN_KEY or API key */
export const authLogin = async (c: Context) => {
  try {
    const body = await c.req.json<{ key: string }>();
    const adminKey = getEnv("ADMIN_KEY");

    // ADMIN_KEY login
    if (adminKey && body.key === adminKey) {
      return c.json({ ok: true, isAdmin: true });
    }

    // API key login
    const result = await validateApiKey(body.key);
    if (result) {
      return c.json({
        ok: true,
        isAdmin: false,
        keyId: result.id,
        keyName: result.name,
        keyHint: body.key.slice(-4),
      });
    }

    return c.json({ error: "Invalid key" }, 401);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
};

/** POST /auth/logout — no-op (client clears localStorage) */
export const authLogout = (_c: Context) => {
  // Nothing to clean up server-side; client clears its own localStorage
  return _c.json({ ok: true });
};

/** GET /auth/github — start GitHub Device Flow */
export const authGithub = async (c: Context) => {
  try {
    const resp = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: GITHUB_SCOPES,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return c.json({ error: `GitHub error: ${text}` }, 502);
    }

    const data = (await resp.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    return c.json(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

/** POST /auth/github/poll — poll for device flow completion */
export const authGithubPoll = async (c: Context) => {
  try {
    const body = await c.req.json<{ device_code: string }>();

    // Poll GitHub for access token
    const resp = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: body.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );

    const data = (await resp.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
      interval?: number;
    };

    if (data.error === "authorization_pending") {
      return c.json({ status: "pending" });
    }

    if (data.error === "slow_down") {
      return c.json({ status: "slow_down", interval: data.interval });
    }

    if (data.error) {
      return c.json(
        { status: "error", error: data.error_description ?? data.error },
        400,
      );
    }

    if (data.access_token) {
      // Fetch user info
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `token ${data.access_token}`,
          accept: "application/json",
          "user-agent": "copilot-deno",
        },
      });

      let user: GitHubUser = {
        login: "unknown",
        avatar_url: "",
        name: null,
        id: 0,
      };
      if (userResp.ok) {
        user = (await userResp.json()) as GitHubUser;
      }

      // Store account and set as active
      const accountType = await detectAccountType(data.access_token);
      await addGithubAccount(data.access_token, user, accountType);
      await clearCopilotTokenCache();
      clearModelsCache();
      return c.json({ status: "complete", user });
    }

    return c.json({ status: "error", error: "Unknown response" }, 500);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

/** GET /auth/me — get all GitHub accounts + active account info */
export const authMe = async (c: Context) => {
  const accounts = await listGithubAccounts();
  const active = await getActiveGithubAccount();

  // If we have an active account but no user info cached, try to fetch it
  if (active && !active.user.login) {
    try {
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `token ${active.token}`,
          accept: "application/json",
          "user-agent": "copilot-deno",
        },
      });
      if (userResp.ok) {
        active.user = (await userResp.json()) as GitHubUser;
        await addGithubAccount(active.token, active.user, active.accountType);
      }
    } catch {
      // Ignore — user just stays as-is
    }
  }

  return c.json({
    authenticated: true,
    github_connected: accounts.length > 0,
    accounts: accounts.map((a) => ({
      id: a.user.id,
      login: a.user.login,
      name: a.user.name,
      avatar_url: a.user.avatar_url,
      account_type: a.accountType,
      active: active?.user.id === a.user.id,
    })),
  });
};

/** DELETE /auth/github/:id — disconnect a specific GitHub account */
export const authGithubDisconnect = async (c: Context) => {
  const userId = Number(c.req.param("id"));
  if (!userId || isNaN(userId)) {
    return c.json({ error: "Invalid user ID" }, 400);
  }
  await removeGithubAccount(userId);
  await clearCopilotTokenCache();
  clearModelsCache();
  return c.json({ ok: true });
};

/** POST /auth/github/switch — switch active GitHub account */
export const authGithubSwitch = async (c: Context) => {
  const body = await c.req.json<{ user_id: number }>();
  if (!body.user_id) {
    return c.json({ error: "user_id is required" }, 400);
  }
  const ok = await setActiveGithubAccount(body.user_id);
  if (!ok) {
    return c.json({ error: "Account not found" }, 404);
  }
  await clearCopilotTokenCache();
  clearModelsCache();
  return c.json({ ok: true });
};

async function detectAccountType(githubToken: string): Promise<string> {
  try {
    const resp = await fetch("https://api.github.com/copilot_internal/user", {
      headers: await githubHeaders(githubToken),
    });
    if (!resp.ok) return "individual";
    const data = (await resp.json()) as { copilot_plan?: string };
    if (data.copilot_plan && ["individual", "business", "enterprise"].includes(data.copilot_plan)) {
      return data.copilot_plan;
    }
    return "individual";
  } catch {
    return "individual";
  }
}
