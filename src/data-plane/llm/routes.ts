import type { Hono } from "hono";
import { serveChatCompletions } from "./sources/chat-completions/serve.ts";
import { serveMessages } from "./sources/messages/serve.ts";
import { countTokens } from "./sources/messages/count-tokens/serve.ts";
import { serveResponses } from "./sources/responses/serve.ts";

export const mountLlmRoutes = (app: Hono) => {
  app.post("/v1/chat/completions", serveChatCompletions);
  app.post("/chat/completions", serveChatCompletions);
  app.post("/v1/responses", serveResponses);
  app.post("/responses", serveResponses);
  app.post("/v1/messages", serveMessages);
  app.post("/messages", serveMessages);
  app.post("/v1/messages/count_tokens", countTokens);
  app.post("/messages/count_tokens", countTokens);
};
