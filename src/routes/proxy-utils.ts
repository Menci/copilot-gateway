import type { Context } from "hono";

type ProxyErrorStatus = 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503;

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function apiErrorResponse(
  c: Context,
  message: string,
  status: ProxyErrorStatus = 502,
): Response {
  return c.json({ error: { message, type: "api_error" } }, status);
}

export function anthropicApiErrorResponse(
  c: Context,
  message: string,
  status: ProxyErrorStatus = 502,
): Response {
  return c.json(
    { type: "error", error: { type: "api_error", message } },
    status,
  );
}

export function noUpstreamBodyApiErrorResponse(c: Context): Response {
  return apiErrorResponse(c, "No response body from upstream", 502);
}

export function noUpstreamBodyAnthropicErrorResponse(c: Context): Response {
  return anthropicApiErrorResponse(c, "No response body from upstream", 502);
}

export function proxyJsonResponse(resp: Response): Response {
  return new Response(resp.body, {
    status: resp.status,
    headers: {
      "content-type": resp.headers.get("content-type") ?? "application/json",
    },
  });
}
