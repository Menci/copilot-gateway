// POST /v1/embeddings — passthrough to Copilot

import type { Context } from "hono";
import { copilotFetch } from "../lib/copilot.ts";
import { getEnv, getGithubTokenAsync } from "../middleware/auth.ts";

export const embeddings = async (c: Context) => {
  try {
    const body = await c.req.text();
    const githubToken = await getGithubTokenAsync();
    const resp = await copilotFetch(
      "/embeddings",
      { method: "POST", body },
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
