# Floway

Floway is a self-hosted LLM API gateway for coding agents and API clients. It
puts subscription-backed and token-backed model providers behind one gateway,
then routes each model through the API shape the client already speaks.

## Highlights

- Use GitHub Copilot, ChatGPT subscriptions, Claude.ai subscriptions, Azure AI,
  configurable multi-protocol HTTP providers, and Ollama from one deployment.
- Serve OpenAI, Anthropic, Gemini-compatible, audio transcription, and rerank
  APIs with cross-protocol translation where needed.
- Discover vendor model catalogs live while retaining manual model configuration
  for providers that require or permit it.
- Manage upstreams, routing order, model aliases, API keys, and web search from
  a dashboard.
- Generate one-command Claude Code and Codex configurations from an API key.
- Run on Cloudflare Workers or Node.js, with Docker Compose provided for a
  self-hosted server and dashboard.

## Quick Start

Docker Compose is the shortest path to a complete local deployment:

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:18088>, leave the username blank, and use `ADMIN_KEY` as
the password. Then:

1. Add at least one provider under **Providers → Upstreams**.
2. Create a key under **Services → API Keys**.
3. Give that key to a client as a bearer token or `x-api-key`, or use **Agent
   Setup** to configure Claude Code or Codex.

The data-plane and control-plane APIs are also exposed directly at
<http://localhost:8788>. SQLite, file-backed dump bodies, and oversized
Stateful OpenAI Responses item payloads persist in the `floway-data` volume.

The dashboard uses Floway's control plane to manage users, keys, upstreams,
routing, and telemetry. Coding agents and API clients call the data plane,
which performs model resolution, upstream dispatch, and any required protocol
translation. Both planes are served by the same gateway process.

## Compatibility

### Client APIs

| API | Routes |
| --- | --- |
| OpenAI Completions | `POST /v1/completions` |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses`, `POST /v1/responses/compact`, WebSocket `GET /v1/responses` |
| OpenAI Embeddings | `POST /v1/embeddings` |
| OpenAI Images | `POST /v1/images/generations`, `POST /v1/images/edits` |
| OpenAI Audio Transcriptions | `POST /v1/audio/transcriptions` |
| OpenAI Models | `GET /v1/models`, `GET /models` |
| Anthropic Messages | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| Google Gemini | `GET /v1beta/models`, `GET /v1beta/models/{model}`, `POST /v1beta/models/{model}:generateContent`, `POST /v1beta/models/{model}:streamGenerateContent`, `POST /v1beta/models/{model}:countTokens` |
| Cohere Rerank v1 | `POST /v1/rerank` |
| Cohere Rerank v2 | `POST /v2/rerank` |
| Jina Rerank | `POST /jina/v1/rerank` |
| Voyage Rerank | `POST /voyage/v1/rerank` |

`/v1/models` and `/models` return Floway's public model superset to ordinary
callers and select the Codex or Claude Code discovery shape for those clients'
User-Agent.

Rerank models are manual Custom models. Each model selects its outbound Cohere,
Jina, Voyage, DashScope-compatible, or DashScope-native protocol and may
override that protocol's canonical path; there is no upstream-wide rerank path.

Audio transcription is a buffered multipart passthrough for Custom, Azure, and
Ollama-compatible upstreams. JSON, text, subtitle, and transcription SSE
responses retain their upstream wire shape.

### Upstreams

| Provider | Connection | Model catalog |
| --- | --- | --- |
| GitHub Copilot | GitHub device OAuth on `github.com` or a `*.ghe.com` tenant | Fetched live from Copilot |
| Codex | ChatGPT subscription through the Codex CLI OAuth client | Live inference catalog plus the account's built-in GPT Image capability |
| Claude Code | Claude.ai Pro, Max, Team, or Enterprise subscription through the Claude Code CLI OAuth client | Fetched live from Anthropic |
| Custom | Configurable multi-protocol HTTP endpoint, credential, and per-header ingress passthrough/overwrite rules | Live `/models` (OpenAI, Anthropic, or superset shapes), manual models, or both |
| Azure | Azure AI resource or Foundry project endpoint and API key | Configured models |
| Ollama | ollama.com or a self-hosted Ollama-compatible server | Fetched live from Ollama, with optional manual overrides |

## Other Deployment Options

### Cloudflare Workers

Requires Node.js 22.5+, pnpm 10.x, and a Cloudflare account.

```bash
pnpm install
pnpm wrangler login
cp wrangler.example.jsonc wrangler.jsonc

# Follow the comments in wrangler.jsonc to create the required resources and
# replace every <YOUR_*> placeholder.
pnpm run db:migrate
pnpm run dev
```

The local dashboard runs at <http://localhost:5174>. For an agent-assisted
production deployment, invoke `$deploy-to-cloudflare`. It uses the established
update and rollback flow by default. A deployment named as new first runs an
isolated binding-probe bootstrap and requires its `Hello World` response before
publishing Floway.

For a manual production update, configure the admin secret, then apply the
remote migrations and deploy as one step — publishing the code that reads a
migration's result is part of applying it, and stopping in between leaves the
previous build serving rewritten configuration:

```bash
pnpm wrangler secret put ADMIN_KEY
pnpm run db:migrate:remote && pnpm run deploy
```

### Node.js

The Node.js target applies SQLite migrations automatically and defaults to
`./data/floway.db`, `./data/files`, and port `8788`:

```bash
pnpm install
ADMIN_KEY='replace-with-a-secret' pnpm run dev:node
```

It serves the dashboard, data-plane, and control-plane APIs from the same
origin. `dev:node` binds `127.0.0.1` by default; set `HOST=0.0.0.0` when the
service must accept network connections. `dev:node` builds the web bundle
before starting; deployments that build separately may set
`FLOWAY_WEB_DIST_DIR` to the bundle directory (default:
`apps/web/dist/client`). Production Node.js deployments must set both
`NODE_ENV=production` and a non-empty `ADMIN_KEY`.

Podman users can instead follow the
[systemd deployment guide](./docker/systemd/README.md).

## Development

```bash
pnpm install
pnpm run dev
pnpm run verify
```

`verify` chains every check in `.github/workflows/verify.yaml`: `typegen`,
`lint`, `typecheck`, `test`, `test:installers`, `check:agents-md`,
`check:generated-assets`, `check:verify-parity`, and `build:web`. Each check is
also available as a root script. Route type generation runs first because the
web app's generated types are not checked in and its lint configuration is
type-aware. The web build includes assertions on the emitted bundle.

The protocol tests cover opaque-value wire compatibility, lossless UTF-16
code-unit recovery, and retained-memory growth during history replay. The
memory regression runs a bounded fixture in a separate Node.js process with
explicit garbage collection, samples the retained heap before content checks
can flatten strings, and then verifies every decoded value. It runs through
`pnpm run test` and `pnpm run verify` without additional setup; this local
regression is not a measurement of a production Worker's peak memory.

[AGENTS.md](./AGENTS.md) defines the repository-wide agent requirements and
indexes its CI workflows, skills, workspace packages, and their responsibilities.

## License

MIT
