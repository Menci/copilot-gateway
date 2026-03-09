// POST /v1/chat/completions — passthrough to Copilot

import type { Context } from "hono";
import { copilotFetch } from "../lib/copilot.ts";
import { getEnv, getGithubTokenAsync } from "../middleware/auth.ts";

/** Detect if request body contains image content */
function hasVision(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return msg.content.some(
      (part: { type?: string }) => part.type === "image_url",
    );
  });
}

export const chatCompletions = async (c: Context) => {
  try {
    const body = await c.req.json();
    const vision = hasVision(body);
    const githubToken = await getGithubTokenAsync();

    const resp = await copilotFetch(
      "/chat/completions",
      { method: "POST", body: JSON.stringify(body) },
      githubToken,
      getEnv("ACCOUNT_TYPE"),
      { vision },
    );

    const contentType =
      resp.headers.get("content-type") ?? "application/json";

    if (contentType.includes("text/event-stream")) {
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};
