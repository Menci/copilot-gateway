import type { Context } from "hono";
import { copilotFetch } from "../../../../../lib/copilot.ts";
import { getGithubCredentials } from "../../../../../lib/github.ts";
import { normalizeModelName } from "../../../../../lib/model-name.ts";
import type { MessagesPayload } from "../../../../../lib/messages-types.ts";

export const countTokens = async (c: Context) => {
  try {
    const payload = await c.req.json<MessagesPayload>();
    if (typeof payload.model === "string") {
      payload.model = normalizeModelName(payload.model);
    }

    const { token: githubToken, accountType } = await getGithubCredentials();

    const resp = await copilotFetch(
      "/v1/messages/count_tokens",
      { method: "POST", body: JSON.stringify(payload) },
      githubToken,
      accountType,
    );

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Error counting tokens:", msg);
    return c.json({
      error: {
        type: "invalid_request_error",
        message: `Failed to count tokens: ${msg}`,
      },
    }, 400);
  }
};
