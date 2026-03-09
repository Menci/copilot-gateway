// copilot-deno — GitHub Copilot API proxy for Deno Deploy
//
// Exposes:
//   POST /v1/chat/completions   (OpenAI-compatible, passthrough)
//   POST /v1/messages           (Anthropic-compatible, translated)
//   POST /v1/embeddings         (OpenAI-compatible, passthrough)
//   POST /v1/responses          (OpenAI Responses API, passthrough)
//   GET  /v1/models
//   GET  /usage
//
// Frontend:
//   GET  /              — Login page (or JSON health check for API clients)
//   GET  /dashboard     — Usage dashboard
//
// Auth: unified ACCESS_KEY via ?key=, x-api-key header, or Authorization: Bearer header
// Frontend auth: ACCESS_KEY stored in localStorage, sent as x-api-key header

import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { chatCompletions } from "./routes/chat-completions.ts";
import { models } from "./routes/models.ts";
import { messages } from "./routes/messages.ts";
import { embeddings } from "./routes/embeddings.ts";
import { usage } from "./routes/usage.ts";
import { responses } from "./routes/responses.ts";
import { countTokens } from "./routes/count-tokens.ts";
import {
  authLogin,
  authLogout,
  authGithub,
  authGithubPoll,
  authMe,
} from "./routes/auth.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { loginPage, dashboardPage } from "./routes/pages.tsx";

const app = new Hono();

app.use("*", logger());
app.use("*", cors());
app.use("*", authMiddleware);

// Frontend pages (public — auth handled client-side)
app.get("/", (c) => {
  // If Accept header prefers JSON (API clients), return health check
  const accept = c.req.header("accept") ?? "";
  if (
    accept.includes("application/json") &&
    !accept.includes("text/html")
  ) {
    return c.json({ status: "ok", service: "copilot-deno" });
  }
  // Browser requests get the login page
  return loginPage(c);
});
app.get("/dashboard", dashboardPage);

// Dashboard API (same ACCESS_KEY auth as everything else)
app.get("/api/usage", usage);

// OpenAI-compatible
app.post("/v1/chat/completions", chatCompletions);
app.post("/chat/completions", chatCompletions);
app.get("/v1/models", models);
app.get("/models", models);
app.post("/v1/embeddings", embeddings);
app.post("/embeddings", embeddings);
app.post("/v1/responses", responses);
app.post("/responses", responses);

// Anthropic-compatible
app.post("/v1/messages", messages);
app.post("/v1/messages/count_tokens", countTokens);

// Usage (API key auth)
app.get("/usage", usage);

// Auth
app.post("/auth/login", authLogin);
app.post("/auth/logout", authLogout);
app.get("/auth/github", authGithub);
app.post("/auth/github/poll", authGithubPoll);
app.get("/auth/me", authMe);

Deno.serve(app.fetch);
