import type { Context, Next } from "hono";
import { getGithubToken } from "../lib/session.ts";

const PUBLIC_PATHS = new Set(["/", "/dashboard"]);
const AUTH_VALIDATE_PATHS = new Set(["/auth/login"]);

// deno-lint-ignore require-await
export const authMiddleware = async (c: Context, next: Next) => {
  const path = c.req.path;

  if (PUBLIC_PATHS.has(path) && c.req.method === "GET") return next();
  if (AUTH_VALIDATE_PATHS.has(path) && c.req.method === "POST") return next();

  const key = extractKey(c);
  const expectedKey = getEnv("ACCESS_KEY");
  if (!expectedKey || key !== expectedKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
};

function extractKey(c: Context): string | null {
  const url = new URL(c.req.url);
  return (
    url.searchParams.get("key") ??
    c.req.header("x-api-key") ??
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    null
  );
}

export function getEnv(name: string): string {
  // deno-lint-ignore no-explicit-any
  return (Deno as any).env.get(name) ?? "";
}

export function getGithubTokenAsync(): Promise<string> {
  return getGithubToken();
}
