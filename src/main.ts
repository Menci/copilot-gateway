// copilot-deno — GitHub Copilot API proxy for Deno Deploy
//
// Data plane (API key required):
//   POST /v1/chat/completions   (OpenAI-compatible, passthrough)
//   POST /v1/messages           (Anthropic-compatible, translated)
//   POST /v1/embeddings         (OpenAI-compatible, passthrough)
//   POST /v1/responses          (OpenAI Responses API, passthrough)
//   GET  /v1/models
//
// Control plane (ADMIN_KEY or API key via /api/, /auth/ prefixes):
//   GET  /api/copilot-quota     — upstream Copilot quota (admin only)
//   GET  /api/token-usage       — per-key token usage records
//   GET  /api/models            — model list for dashboard
//   CRUD /api/keys              — API key management (admin only)
//
// Frontend:
//   GET  /              — Login page (or JSON health check for API clients)
//   GET  /dashboard     — Dashboard
//
// Auth: ADMIN_KEY (dashboard only) or per-key API keys via ?key=, x-api-key, or Authorization: Bearer

import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { chatCompletions } from "./routes/chat-completions.ts";
import { models } from "./routes/models.ts";
import { messages } from "./routes/messages.ts";
import { embeddings } from "./routes/embeddings.ts";
import { copilotQuota } from "./routes/copilot-quota.ts";
import { responses } from "./routes/responses.ts";
import { countTokens } from "./routes/count-tokens.ts";
import {
  authLogin,
  authLogout,
  authGithub,
  authGithubPoll,
  authGithubDisconnect,
  authGithubSwitch,
  authMe,
} from "./routes/auth.ts";
import { authMiddleware, adminOnlyMiddleware } from "./middleware/auth.ts";
import { usageMiddleware } from "./middleware/usage.ts";
import { LoginPage } from "./ui/login.tsx";
import { DashboardPage } from "./ui/dashboard.tsx";
import { listKeys, createKey, deleteKey, rotateKey, renameKey } from "./routes/api-keys.ts";
import { tokenUsage } from "./routes/token-usage.ts";

const app = new Hono();

app.use("*", logger());
app.use("*", cors());
app.use("*", authMiddleware);
app.use("*", usageMiddleware);

// Frontend pages (public — auth handled client-side)
app.get("/", (c) => {
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return c.json({ status: "ok", service: "copilot-deno" });
  }
  return c.html(LoginPage());
});
app.get("/dashboard", (c) => c.html(DashboardPage()));
app.get("/favicon.ico", () => new Response(null, { status: 204 }));

// Auth — open to any authenticated user
app.post("/auth/login", authLogin);
app.post("/auth/logout", authLogout);

// Auth — admin only
const adminAuth = new Hono();
adminAuth.use("*", adminOnlyMiddleware);
adminAuth.get("/github", authGithub);
adminAuth.post("/github/poll", authGithubPoll);
adminAuth.delete("/github/:id", authGithubDisconnect);
adminAuth.post("/github/switch", authGithubSwitch);
adminAuth.get("/me", authMe);
app.route("/auth", adminAuth);

// Control plane — any authenticated
app.get("/api/token-usage", tokenUsage);
app.get("/api/models", models);

// Control plane — admin only
const adminApi = new Hono();
adminApi.use("*", adminOnlyMiddleware);
adminApi.get("/copilot-quota", copilotQuota);
adminApi.get("/keys", listKeys);
adminApi.post("/keys", createKey);
adminApi.post("/keys/:id/rotate", rotateKey);
adminApi.patch("/keys/:id", renameKey);
adminApi.delete("/keys/:id", deleteKey);
app.route("/api", adminApi);

// Data plane — OpenAI-compatible
app.post("/v1/chat/completions", chatCompletions);
app.post("/chat/completions", chatCompletions);
app.get("/v1/models", models);
app.get("/models", models);
app.post("/v1/embeddings", embeddings);
app.post("/embeddings", embeddings);
app.post("/v1/responses", responses);
app.post("/responses", responses);

// Data plane — Anthropic-compatible
app.post("/v1/messages", messages);
app.post("/v1/messages/count_tokens", countTokens);

Deno.serve(app.fetch);
