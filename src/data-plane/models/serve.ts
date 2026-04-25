// GET /v1/models, /api/models — proxy to Copilot models endpoint

import type { Context } from "hono";
import { copilotFetch } from "../../lib/copilot.ts";
import { getGithubCredentials } from "../../lib/github.ts";
import {
  apiErrorResponse,
  getErrorMessage,
  proxyJsonResponse,
} from "../shared/http/proxy-response.ts";

export const models = async (c: Context) => {
  try {
    const { token: githubToken, accountType } = await getGithubCredentials();
    const resp = await copilotFetch(
      "/models",
      { method: "GET" },
      githubToken,
      accountType,
    );
    return proxyJsonResponse(resp);
  } catch (e: unknown) {
    return apiErrorResponse(c, getErrorMessage(e), 502);
  }
};
