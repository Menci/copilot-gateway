# Copilot Gateway

A lightweight and secure API proxy deployed on serverless platforms that exposes
your GitHub Copilot subscription as standard **Anthropic Messages API** and
**OpenAI Responses API** endpoints — letting you use
[Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[Codex CLI](https://github.com/openai/codex), and other coding agents through
Copilot.

## How It Works

Copilot Gateway translates between API formats on the fly:

- **Claude Code** talks Anthropic Messages API → Gateway translates to whatever
  Copilot supports for that model
- **Codex CLI** talks OpenAI Responses API → Gateway translates or passes
  through accordingly
- **Any OpenAI-compatible client** can use the Chat Completions endpoint —
  Gateway translates to Messages or Responses API as needed

The gateway auto-detects each model's supported endpoints (native Messages,
Responses, or Chat Completions) and picks the best translation path. When
endpoint metadata is not enough, it also runs and caches lightweight capability
probes (for example, which `reasoning.effort` values a model accepts on
`/responses`) so unsupported fields can be dropped without hardcoding model
names.

## Quick Start

> **Tip**: This project ships with a detailed `AGENTS.md` that describes the
> full architecture, API routes, translation layer, and workarounds. Point your
> coding agent at it (Claude Code and Codex CLI will read it automatically) and
> ask it to explore.

### Prerequisites

- A GitHub account with an active [Copilot](https://github.com/features/copilot)
  subscription
- **Deno** (>= 2.4) or **Node.js** (for Cloudflare Workers via wrangler)

### Deploy to Deno Deploy

```bash
# Clone and enter the project
git clone https://github.com/user/copilot-gateway.git
cd copilot-gateway

# Set the admin key (used to log in to the dashboard)
# On Deno Deploy, set this as an environment variable in the dashboard
export ADMIN_KEY=your-secret-admin-key

# Local development
deno task dev

# Deploy to production (requires Deno >= 2.4)
deno deploy --prod
```

### Deploy to Cloudflare Workers

```bash
# Install dependencies (needed for wrangler and type stubs)
pnpm install

# Create the D1 database
wrangler d1 create copilot-db

# Update wrangler.jsonc with your account_id and database_id, then apply migrations
wrangler d1 migrations apply copilot-db

# Set the admin key as a secret
wrangler secret put ADMIN_KEY

# Local development
wrangler dev

# Deploy to production
wrangler deploy
```

### Initial Setup

1. Open the deployed URL in a browser, log in with your `ADMIN_KEY`
2. Go to the **Upstream** tab and connect your GitHub account (the one with a
   Copilot subscription) via the device OAuth flow
3. Go to the **API Keys** tab and create an API key for your client
4. The **API Keys** tab shows ready-to-copy configuration snippets for both
   Claude Code and Codex CLI

## Architecture

```
Claude Code / Codex CLI / any client
        │
        ▼
  Copilot Gateway (Hono)
  ├── POST /v1/messages          ← Anthropic Messages API
  ├── POST /v1/responses         ← OpenAI Responses API
  ├── POST /v1/chat/completions  ← OpenAI Chat Completions
  ├── POST /v1/embeddings        ← Embeddings passthrough
  └── GET  /v1/models            ← Model listing
        │
        ▼ (auto-selects translation path per model)
  GitHub Copilot API
```

> 95% of the code is platform-agnostic (Hono + Web APIs). Platform-specific
> storage is abstracted behind a repository layer — `DenoKvRepo` for Deno
> Deploy, `D1Repo` for Cloudflare Workers.

## License

MIT
