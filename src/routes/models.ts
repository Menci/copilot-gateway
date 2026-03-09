// GET /v1/models — proxy to Copilot models endpoint

import type { Context } from "hono";
import { copilotFetch } from "../lib/copilot.ts";
import { getEnv, getGithubTokenAsync } from "../middleware/auth.ts";

export const models = async (c: Context) => {
  try {
    const githubToken = await getGithubTokenAsync();
    const resp = await copilotFetch(
      "/models",
      { method: "GET" },
      githubToken,
      getEnv("ACCOUNT_TYPE"),
    );
    return new Response(resp.body, {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};
