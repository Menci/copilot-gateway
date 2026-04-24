import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { serveChatCompletions } from "./data-plane/sources/chat-completions/serve.ts";
import { models } from "./routes/models.ts";
import { serveMessages } from "./data-plane/sources/messages/serve.ts";
import { embeddings } from "./routes/embeddings.ts";
import { copilotQuota } from "./routes/copilot-quota.ts";
import { serveResponses } from "./data-plane/sources/responses/serve.ts";
import { countTokens } from "./routes/count-tokens.ts";
import {
  authGithub,
  authGithubDisconnect,
  authGithubPoll,
  authGithubSwitch,
  authLogin,
  authLogout,
  authMe,
} from "./routes/auth.ts";
import { adminOnlyMiddleware, authMiddleware } from "./middleware/auth.ts";
import { usageMiddleware } from "./middleware/usage.ts";
import { LoginPage } from "./ui/login.tsx";
import { DashboardPage } from "./ui/dashboard.tsx";
import {
  createKey,
  deleteKey,
  listKeys,
  renameKey,
  rotateKey,
} from "./routes/api-keys.ts";
import { tokenUsage } from "./routes/token-usage.ts";
import { exportData, importData } from "./routes/data-transfer.ts";
import {
  getSearchConfigRoute,
  putSearchConfigRoute,
  testSearchConfigRoute,
} from "./routes/search-config.ts";

export const app = new Hono();

app.use("*", logger());
app.use("*", cors());
app.use("*", authMiddleware);
app.use("*", usageMiddleware);

app.get("/", (c) => {
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return c.json({ status: "ok", service: "copilot-deno" });
  }
  return c.html(LoginPage());
});
app.get("/dashboard", (c) => c.html(DashboardPage()));
app.get("/favicon.ico", () => new Response(null, { status: 204 }));

app.post("/auth/login", authLogin);
app.post("/auth/logout", authLogout);

const adminAuth = new Hono();
adminAuth.use("*", adminOnlyMiddleware);
adminAuth.get("/github", authGithub);
adminAuth.post("/github/poll", authGithubPoll);
adminAuth.delete("/github/:id", authGithubDisconnect);
adminAuth.post("/github/switch", authGithubSwitch);
adminAuth.get("/me", authMe);
app.route("/auth", adminAuth);

app.get("/api/keys", listKeys);
app.get("/api/token-usage", tokenUsage);
app.get("/api/models", models);

const adminApi = new Hono();
adminApi.use("*", adminOnlyMiddleware);
adminApi.get("/copilot-quota", copilotQuota);
adminApi.post("/keys", createKey);
adminApi.post("/keys/:id/rotate", rotateKey);
adminApi.patch("/keys/:id", renameKey);
adminApi.delete("/keys/:id", deleteKey);
adminApi.get("/search-config", getSearchConfigRoute);
adminApi.put("/search-config", putSearchConfigRoute);
adminApi.post("/search-config/test", testSearchConfigRoute);
adminApi.get("/export", exportData);
adminApi.post("/import", importData);
app.route("/api", adminApi);

app.post("/v1/chat/completions", serveChatCompletions);
app.post("/chat/completions", serveChatCompletions);
app.get("/v1/models", models);
app.get("/models", models);
app.post("/v1/embeddings", embeddings);
app.post("/embeddings", embeddings);
app.post("/v1/responses", serveResponses);
app.post("/responses", serveResponses);

app.post("/v1/messages", serveMessages);
app.post("/messages", serveMessages);
app.post("/v1/messages/count_tokens", countTokens);
app.post("/messages/count_tokens", countTokens);
