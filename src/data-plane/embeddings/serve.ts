// POST /v1/embeddings — forward embedding requests to Copilot

import type { Context } from "hono";
import { copilotFetch } from "../../lib/copilot.ts";
import { getGithubCredentials } from "../../lib/github.ts";
import {
  apiErrorResponse,
  getErrorMessage,
  proxyJsonResponse,
} from "../shared/http/proxy-response.ts";

export const embeddings = async (c: Context) => {
  try {
    const body = await c.req.text();
    const { token: githubToken, accountType } = await getGithubCredentials();
    const resp = await copilotFetch(
      "/embeddings",
      { method: "POST", body },
      githubToken,
      accountType,
    );

    return proxyJsonResponse(resp);
  } catch (e: unknown) {
    return apiErrorResponse(c, getErrorMessage(e), 502);
  }
};
