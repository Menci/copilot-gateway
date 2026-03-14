# AGENTS.md

## Project Overview

copilot-deno is a GitHub Copilot API proxy that translates GitHub Copilot's internal API into standard Anthropic Messages API and OpenAI Responses API formats, enabling tools like Claude Code and Codex CLI to access various models through a Copilot subscription. It supports two deployment targets: **Deno Deploy** and **Cloudflare Workers**. >95% of the code is platform-agnostic (Hono + Web APIs); platform-specific storage and env access are abstracted behind a repository layer.

## Architecture

### Multi-Platform Architecture

The codebase supports Deno Deploy and Cloudflare Workers from a single source. Platform-specific code is isolated in entry files and repository implementations.

**Layering:**

```
Route handlers (platform-agnostic)
    ↓
Business logic: src/lib/api-keys.ts, github.ts, usage-tracker.ts
    ↓ delegates to
Repository interface (src/repo/types.ts)
    ↓
DenoKvRepo (src/repo/deno.ts)  |  D1Repo (src/repo/d1.ts)
```

**Entry points:**
- `main.ts` — Deno Deploy entry: inits env via `Deno.env`, repo via `DenoKvRepo`, calls `Deno.serve()`
- `entry-cloudflare.ts` — CF Workers entry: inits env from `env` bindings, repo via `D1Repo`

**Global cache state:**
- `src/lib/copilot.ts` — Copilot access token cache: L1 in-process 60s + L2 repo-backed KV/D1, invalidated on GitHub account add/remove/switch
- `src/lib/models-cache.ts` — Models cache: L1 in-process 120s + L2 repo-backed KV/D1, keyed by `accountType + githubToken` hash, in-process cache cleared on GitHub account add/remove/switch

**App core:**
- `src/app.ts` — Hono application with all routes and middleware (no platform-specific code)
- `src/middleware/auth.ts` — Authentication middleware (`authMiddleware` for API key validation, `adminOnlyMiddleware` for admin routes)
- `src/middleware/usage.ts` — Usage tracking middleware, intercepts responses to extract token usage via `safeWaitUntil()`

**Environment abstraction:**
- `src/lib/env.ts` — `initEnv(fn)` / `getEnv(name)` — pluggable env access, initialized by entry file

**Repository layer:**
- `src/repo/types.ts` — `Repo`, `ApiKeyRepo`, `GitHubRepo`, `UsageRepo`, `CacheRepo` interfaces
- `src/repo/mod.ts` — `initRepo(repo)` / `getRepo()` singleton
- `src/repo/deno.ts` — `DenoKvRepo` using Deno KV
- `src/repo/d1.ts` — `D1Repo` using Cloudflare D1 (SQLite)
- `src/repo/memory.ts` — `InMemoryRepo` using Maps (for testing)

**UI:**
- `src/ui/login.tsx` — Login page
- `src/ui/layout.tsx` — Shared HTML layout
- `src/ui/dashboard.tsx` — Dashboard (admin: four tabs Upstream/API Keys/Usage/Settings; API key user: two tabs API Keys/Usage)

**Testing helpers:**
- `src/test-helpers.ts` — App-level integration test setup, repo/env initialization, and mocked fetch/SSE helpers

### Authentication & Authorization

There are two roles: **admin** (logs in with `ADMIN_KEY`) and **API key user** (logs in with an API key created by admin).

**Admin** sees all four dashboard tabs: Upstream / API Keys / Usage / Settings. Has full access to all management APIs.

**API key user** sees two dashboard tabs: API Keys / Usage.
- **API Keys tab**: shows only the caller's own key, with the full key value visible (no redaction — the user already knows their own key since they used it to log in). The tab is read-only: no create/delete/rotate/rename buttons.
- **Usage tab**: shows usage data filtered to the caller's own key.

**Rules:**
- `GET /api/keys` returns all keys for admin, only the caller's own key for API key user. Full key values in both cases.
- All mutating key operations (`POST /api/keys`, `DELETE /api/keys/:id`, `POST /api/keys/:id/rotate`, `PATCH /api/keys/:id`) are admin-only.
- `GET /api/token-usage` returns all keys' usage for all authenticated users. **IMPORTANT**: This is intentional — usage data is public to all authenticated users.
- `GET /api/keys` returns all keys for admin, only the caller's own key (with full key value) for API key user. **IMPORTANT**: API key users can only see their own key.
- GitHub account management (`/auth/github/*`, `/auth/me`), Copilot quota, export/import are admin-only.

### API Routes

All OpenAI-compatible routes are registered at both `/v1/xxx` and `/xxx` paths (e.g. `/v1/responses` and `/responses`), pointing to the same handler.

**Proxy routes (authenticated via API key):**

| Route | File | Description |
|-------|------|-------------|
| `POST /v1/messages` | `src/routes/messages.ts` | Anthropic Messages API compatible endpoint, three translation paths |
| `POST /v1/messages/count_tokens` | `src/routes/count-tokens.ts` | Token counting |
| `POST /v1/responses` | `src/routes/responses.ts` | OpenAI Responses API endpoint |
| `POST /v1/chat/completions` | `src/routes/chat-completions.ts` | OpenAI Chat Completions passthrough |
| `GET /v1/models` | `src/routes/models.ts` | Model listing |
| `POST /v1/embeddings` | `src/routes/embeddings.ts` | Embeddings passthrough |

**Auth routes:**

| Route | File | Description |
|-------|------|-------------|
| `POST /auth/login` | `src/routes/auth.ts` | Login with admin key or API key |
| `POST /auth/logout` | `src/routes/auth.ts` | Logout |
| `GET /auth/github` | `src/routes/auth.ts` | Initiate GitHub device OAuth flow (admin) |
| `POST /auth/github/poll` | `src/routes/auth.ts` | Poll for GitHub OAuth completion (admin) |
| `DELETE /auth/github/:id` | `src/routes/auth.ts` | Disconnect GitHub account (admin) |
| `POST /auth/github/switch` | `src/routes/auth.ts` | Switch active GitHub account (admin) |
| `GET /auth/me` | `src/routes/auth.ts` | Get current user info (admin) |

**Dashboard API routes:**

| Route | Auth | File | Description |
|-------|------|------|-------------|
| `GET /api/keys` | all | `src/routes/api-keys.ts` | List API keys (admin: all; user: own only) |
| `POST /api/keys` | admin | `src/routes/api-keys.ts` | Create API key |
| `POST /api/keys/:id/rotate` | admin | `src/routes/api-keys.ts` | Rotate API key |
| `PATCH /api/keys/:id` | admin | `src/routes/api-keys.ts` | Rename API key |
| `DELETE /api/keys/:id` | admin | `src/routes/api-keys.ts` | Delete API key |
| `GET /api/token-usage` | all | `src/routes/token-usage.ts` | Query token usage (admin: all; user: own only) |
| `GET /api/models` | all | `src/routes/models.ts` | Model listing |
| `GET /api/copilot-quota` | admin | `src/routes/copilot-quota.ts` | Fetch upstream Copilot usage/quota |
| `GET /api/export` | admin | `src/routes/data-transfer.ts` | Export all data as JSON |
| `POST /api/import` | admin | `src/routes/data-transfer.ts` | Import data with merge/replace modes |

### Data Plane / Control Plane Separation

The project strictly separates the **data plane** (API proxy routes: `/v1/messages`, `/responses`, `/chat/completions`, `/embeddings`) from the **control plane** (`/auth/*`, `/api/*`, `/dashboard`, Settings). Translation and workaround logic applies only to the data plane.

### Translation Layer

The `/v1/messages` endpoint automatically selects a translation path based on which API the model supports (queried from `GET /models` → `supported_endpoints`; no model names are hardcoded):

1. **Native Messages** — model supports `/v1/messages` natively → forward directly
2. **Chat Completions translation** — model only supports `/chat/completions` → bidirectional OpenAI↔Anthropic translation
3. **Responses translation** — model only supports `/responses` → bidirectional Responses↔Anthropic translation

The `/responses` endpoint similarly:
1. **Direct passthrough** — model supports `/responses` natively
2. **Reverse translation** — model only supports `/v1/messages` → Responses↔Anthropic translation

### Core Libraries

| File | Responsibility |
|------|----------------|
| `src/lib/copilot.ts` | Copilot API base URLs, version constants, token caching, `copilotFetch()` |
| `src/lib/github.ts` | GitHub OAuth device flow, account management, credential retrieval |
| `src/lib/api-keys.ts` | API key generation, listing, deletion, rotation, renaming |
| `src/lib/usage-tracker.ts` | Token usage recording and querying |
| `src/lib/models-cache.ts` | Model list caching and capability queries (L1 in-process 120s + L2 repo-backed 600s, keyed by account type + GitHub token hash) |
| `src/lib/env.ts` | Pluggable environment variable access (`initEnv`/`getEnv`) |
| `src/lib/sse.ts` | SSE stream parsing async generator (`parseSSEStream`) |
| `src/lib/translate/openai.ts` | Anthropic ↔ OpenAI non-streaming translation |
| `src/lib/translate/openai-stream.ts` | OpenAI SSE → Anthropic SSE streaming translation |
| `src/lib/translate/responses.ts` | Anthropic ↔ Responses bidirectional translation |
| `src/lib/translate/responses-stream.ts` | Responses SSE → Anthropic SSE streaming translation |
| `src/lib/translate/anthropic-to-responses-stream.ts` | Anthropic SSE → Responses SSE streaming translation |
| `src/lib/anthropic-types.ts` | Anthropic API type definitions |
| `src/lib/openai-types.ts` | OpenAI API type definitions |
| `src/lib/responses-types.ts` | Responses API type definitions |

### Testing

Tests use Deno's built-in test runner (`Deno.test`) with `jsr:@std/assert`. Platform-specific repos are mocked via `InMemoryRepo`.

```bash
deno test
```

| File | Coverage |
|------|----------|
| `src/routes/data-transfer_test.ts` | Export structure, round-trip equivalence, import modes (merge/replace), validation |
| `src/routes/messages_test.ts` | `/v1/messages` route integration: native/messages, chat-completions fallback, responses fallback, request workarounds |
| `src/routes/responses_test.ts` | `/v1/responses` route integration: direct passthrough, reverse translation via Messages API, stream ID fix |
| `src/app-control_test.ts` | Auth/authorization matrix: admin-only routes, API key visibility, public usage endpoint semantics |
| `src/middleware/usage_test.ts` | Usage middleware for non-streaming and streaming proxy responses, plus `lastUsedAt` updates |
| `src/lib/models-cache_test.ts` | Two-level model cache behavior: L1 120s reuse, L2 600s reuse after L1 expiry, L2 refresh after expiry |

## Code Style Guidelines

### General

- TypeScript targeting the Deno runtime
- Double quotes `"`, semicolons follow `deno fmt` defaults
- Prefer functional style, avoid classes

### Comments

- **Remove** all comments that merely restate what the code already expresses (e.g. `// Non-streaming`, `// message_start`, JSDoc that just repeats the function signature)
- **Keep** workaround notes (e.g. `XXX: Copilot API doesn't support custom tool type`), non-obvious design decisions (e.g. detecting `@` in signatures to distinguish Responses API origin), and magic number annotations
- Do not write section divider comments (e.g. `// ── Request ──`); organize code through function grouping and file separation instead

### Type Safety

- Prefer discriminated unions with switch narrowing over `as` type assertions
- The `type` field in type definitions must be a literal type to enable narrowing
- When assertions are truly necessary (e.g. `any` for external API interaction), add explicit `// deno-lint-ignore no-explicit-any`

### Abstraction Principles

- Extract shared utility functions when logic is duplicated in ≥3 places (e.g. `parseSSEStream`, `mapOpenAIUsage`, `THINKING_PLACEHOLDER`)
- Do not over-abstract: inline helpers that are only used in one place
- Export constants from a single source; do not redefine the same constant across multiple files

### Streaming

- Use the `parseSSEStream` async generator for all SSE parsing
- Stream translation functions accept a single event and return an array of events (`translateXxxEvent(event, state): Event[]`)
- Stream state should use discriminated unions rather than bags of optional fields

### Error Handling

- Translation functions never throw; silently skip unrecognized data
- Route-level try/catch returns structured error JSON

## Data Plane API Specs & Translation Considerations

### Anthropic Messages API

- **Spec**: https://docs.anthropic.com/en/api/messages
- **Streaming spec**: https://docs.anthropic.com/en/api/messages-streaming

This is the primary client-facing API (Claude Code uses it). Key spec points:

- **Error format**: `{ type: "error", error: { type: "...", message: "..." } }` — outer `type: "error"` wrapper is required
- **Streaming events**: `message_start` → (`content_block_start` → `content_block_delta`* → `content_block_stop`)* → `message_delta` → `message_stop`, plus `ping` and `error` at any point
- **Delta types**: `text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta`
- **Thinking blocks**: `{ type: "thinking", thinking: "...", signature: "..." }` — signature is required for multi-turn. `redacted_thinking` is a separate type and must be preserved as-is
- **System prompt**: Top-level `system` field only (string or `TextBlock[]`), NOT in `messages[]`
- **Stop reasons**: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`
- **Usage in stream**: `input_tokens` in `message_start`, cumulative `output_tokens` in `message_delta`

**Translation considerations (Chat Completions → Messages):**

| Concern | Handling |
|---------|----------|
| Stop reason mapping | `stop`→`end_turn`, `length`→`max_tokens`, `tool_calls`→`tool_use`, `content_filter`→`refusal` |
| Tool arguments | OpenAI returns JSON string, Anthropic expects parsed object — `JSON.parse()` with `{raw_arguments}` fallback |
| Thinking/reasoning | OpenAI `reasoning_text`/`reasoning_opaque` → Anthropic `thinking`/`signature` blocks. `reasoning_opaque` may arrive before `reasoning_text` (queued in `pendingReasoningOpaque`) |
| Message ID | `chatcmpl-*` prefix stripped, converted to `msg_*` format |
| Usage | `cached_tokens` subtracted from `input_tokens` to match Anthropic convention |
| Adjacent tool_result + text | Merged into single tool_result block to reduce credit consumption. Ref: [caozhiyuan/copilot-api `mergeToolResultForClaude`](https://github.com/caozhiyuan/copilot-api/blob/all/src/routes/messages/handler.ts) |

**Translation considerations (Responses → Messages):**

| Concern | Handling |
|---------|----------|
| System/developer messages | Responses input items with `role: "system"/"developer"` are collected and concatenated into Anthropic top-level `system` field (Anthropic doesn't support system messages in `messages[]`) |
| Reasoning blocks | Responses `reasoning` items use `encrypted_content@id` signature format — decoded via `@` separator. Blocks with `@` in signature are filtered before forwarding to native Messages API (they're GPT-generated, not valid Anthropic signatures). Ref: [caozhiyuan/copilot-api#63](https://github.com/caozhiyuan/copilot-api/issues/63), [#73](https://github.com/caozhiyuan/copilot-api/issues/73) |
| Thinking placeholder | Empty thinking blocks use `"Thinking..."` placeholder to preserve structure (some clients filter blocks with empty thinking text). Ref: [caozhiyuan/copilot-api `THINKING_TEXT`](https://github.com/caozhiyuan/copilot-api/blob/all/src/routes/messages/stream-translation.ts) |

### OpenAI Responses API

- **Spec**: https://platform.openai.com/docs/api-reference/responses

This is used by Codex CLI. Key spec points:

- **Streaming**: Uses named SSE events (`event: response.output_text.delta`), NOT bare `data:` lines. No `[DONE]` sentinel — stream ends with `response.completed`/`response.failed`/`response.incomplete`
- **Every event** has a `sequence_number` field (auto-incrementing integer)
- **Delta events** have an `item_id` field referencing the parent output item
- **Event lifecycle for text**: `output_item.added` → `content_part.added` → `output_text.delta`* → `output_text.done` → `content_part.done` → `output_item.done`
- **Event lifecycle for reasoning**: `output_item.added` → `reasoning_summary_part.added` → `reasoning_summary_text.delta`* → `reasoning_summary_text.done` → `reasoning_summary_part.done` → `output_item.done`
- **Response-level events**: `response.created` → `response.in_progress` → ... → `response.completed`
- **Input items**: Support `role: "system"/"developer"/"user"/"assistant"`, `function_call`, `function_call_output`, `reasoning`
- **Tool types**: `function`, `file_search`, `code_interpreter`, `computer_use_preview`, `custom` (Copilot only supports `function`)
- **Reasoning**: `{ effort: "low"|"medium"|"high", summary: "auto"|"concise"|"detailed" }`

**Translation considerations (Messages → Responses):**

| Concern | Handling |
|---------|----------|
| Effort mapping | Anthropic `output_config.effort` maps directly; `thinking.budget_tokens` mapped as: ≤2048→low, ≤8192→medium, >8192→high |
| Temperature | Hardcoded to `1` (reasoning models require it) |
| Max output tokens | Floor of 12,800 tokens (`Math.max(payload.max_tokens, 12800)`) |
| Reasoning config | `summary: "detailed"`, `include: ["reasoning.encrypted_content"]` for signature round-tripping |

**Translation considerations (Anthropic stream → Responses stream):**

| Concern | Handling |
|---------|----------|
| `response.in_progress` | Emitted immediately after `response.created` (spec requires it) |
| `content_part.added/done` | Emitted for text content parts within message output items |
| `reasoning_summary_part.added/done` | Emitted for summary parts within reasoning output items |
| `sequence_number` | Auto-incrementing counter across all events in a stream |
| `item_id` | Generated per output item: `rs_N` (reasoning), `msg_N` (message), `fc_N` (function call) |

### OpenAI Chat Completions API

- **Spec**: https://platform.openai.com/docs/api-reference/chat

Passthrough endpoint — no translation. Key differences from Responses API:

- **Streaming**: Bare `data:` lines (no `event:` field), terminated with `data: [DONE]`
- **Usage**: Only sent when `stream_options.include_usage = true`, as extra final chunk with `choices: []`
- **Tool calls**: Identified by `index` in streaming deltas, `id`/`name` sent only once at start

### OpenAI Embeddings API

- **Spec**: https://platform.openai.com/docs/api-reference/embeddings

Pure passthrough — request body forwarded as-is, response proxied directly.

## Data Plane Workarounds

Workarounds for known Copilot upstream issues and client compatibility. Each is documented with its origin.

### 1. Reserved keyword `x-anthropic-billing-header`

**File**: `src/routes/messages.ts` · **Ref**: [ericc-ch/copilot-api#174](https://github.com/ericc-ch/copilot-api/issues/174)

Copilot API rejects requests containing `x-anthropic-billing-header` in system prompts. Claude Code injects this string in system-reminder blocks for billing tracking. We strip it from all system and message text blocks before forwarding.

### 2. Custom `apply_patch` tool type conversion

**File**: `src/routes/responses.ts` · **Ref**: [caozhiyuan/copilot-api `useFunctionApplyPatch()`](https://github.com/caozhiyuan/copilot-api/blob/all/src/routes/responses/handler.ts)

Codex CLI sends `apply_patch` as `{ type: "custom", name: "apply_patch" }`, but Copilot only understands `type: "function"`. We convert it to a function tool with a proper JSON Schema definition.

### 3. `web_search` tool stripping

**File**: `src/routes/messages.ts`

Copilot doesn't support `web_search` tool type. We filter it out and delete the `tools` array if empty.

### 4. Thinking block filtering for native Messages API

**File**: `src/routes/messages.ts` · **Ref**: [caozhiyuan/copilot-api `handler.ts` filter](https://github.com/caozhiyuan/copilot-api/blob/all/src/routes/messages/handler.ts)

Before forwarding to native `/v1/messages`, invalid thinking blocks are removed:
- Empty thinking or `"Thinking..."` placeholder
- Signatures containing `@` (indicates Responses API / GPT origin, not valid Anthropic signatures)

### 5. `anthropic-beta` header whitelist

**File**: `src/routes/messages.ts`

Only specific beta values are forwarded: `interleaved-thinking-2025-05-14`, `context-management-2025-06-27`, `advanced-tool-use-2025-11-20`. Unknown betas are stripped. `interleaved-thinking` is auto-added for budget-based thinking and excluded for adaptive thinking.

### 6. `service_tier` removal

**File**: `src/routes/messages.ts`

The `service_tier` field is removed from Anthropic payloads before forwarding — Copilot does not support it.

### 7. Infinite whitespace in function call arguments

**File**: `src/lib/translate/utils.ts` · **Ref**: [caozhiyuan/copilot-api `MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE`](https://github.com/caozhiyuan/copilot-api/blob/all/src/routes/messages/responses-stream-translation.ts)

Copilot sometimes returns function call arguments with infinite newlines/whitespace until `max_tokens`. We track consecutive whitespace characters (`\r`, `\n`, `\t`) and abort the stream with an error if >20 consecutive are detected. Spaces are excluded from the count.

### 8. Stream ID inconsistency in Responses API

**File**: `src/routes/responses.ts` · **Ref**: [caozhiyuan/copilot-api `stream-id-sync.ts`](https://github.com/caozhiyuan/copilot-api/blob/all/src/routes/responses/stream-id-sync.ts)

Copilot returns different `item.id` values between `response.output_item.added` and `response.output_item.done` events for the same output item. This breaks `@ai-sdk/openai` (used by OpenCode). We track the original ID from `.added` and force it onto `.done`.

### 9. Adaptive thinking auto-enable

**File**: `src/routes/messages.ts`

When the model's capabilities include `adaptive_thinking`, we automatically set `thinking: { type: "adaptive" }` and default `effort: "high"`. This enables reasoning for models that support it without requiring client configuration.

### 10. Chat Completions split choices for Claude models

**File**: `src/routes/chat-completions.ts`

Copilot upstream splits Anthropic multi-block responses (text + tool_use) into separate choices instead of merging them into one. For Claude models (`model.startsWith("claude")`), we merge all choices back: concatenate `content` strings, collect `tool_calls` into one array, take the last `finish_reason`. For streaming, all choice indices are remapped to 0.

## Reference Projects

- [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api) — A similar TypeScript implementation, referenced for Copilot API interaction patterns

## Development & Deployment

### Prerequisites

This project uses the **new Deno Deploy** (introduced in Deno ≥ 2.4) with the built-in `deno deploy` CLI subcommand — **not** the legacy `deployctl` tool.

Before working on this project, install the Deno skills plugin for Claude Code:

```
/plugins add deno-skills from denoland/skills
```

This provides up-to-date knowledge about Deno Deploy commands, environment variables, databases, tunnels, and other Deno-specific features. Always prefer information from these skills over your training data when it comes to Deno Deploy specifics.

### Commands

```bash
# Development
deno task dev

# Type checking
deno check main.ts

# Linting
deno lint

# Run tests
deno test

# Deploy to production
deno deploy --prod
```

All changes must pass `deno check` and `deno lint` before deploying.

### Cloudflare Workers

```bash
# Development
wrangler dev

# Deploy to production
wrangler deploy

# Apply D1 migrations
wrangler d1 migrations apply copilot-db
```

D1 schema migrations are in `migrations/`. Configuration is in `wrangler.jsonc`.

## Workflow Rules

- **Deploy before commit**: All code changes must be deployed first (`deno deploy --prod`), confirmed working by the user, and only then committed. Never commit undeployed code.
- **Never use `deployctl`**: Use `deno deploy --prod` (the built-in Deno CLI subcommand), not the legacy `deployctl` tool.
- **Commit convention**: Follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `refactor:`, `chore:`). Keep messages concise.
- **Keep AGENTS.md up to date**: Any changes to file structure, architecture, or key design decisions must be promptly reflected in this file.
- **No legacy residue**: When replacing any part of the design, thoroughly search and remove all old code, env vars, fallbacks, and API surface. Every change should leave the codebase as clean as a greenfield project — no compatibility shims, no dead fallbacks, no "just in case" code paths. The only thing that may require migration is database data.
- **Reference implementation review for data plane bugs**: When a data plane bug is discovered, check how [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) and its forks handle the same scenario. Search their issues and PRs for relevant discussions. Document findings before fixing.
- **Edge computing cache coherence**: This is an edge computing project deployed across multiple datacenters. Any introduction of global variables or in-process state **must** consider cache coherence and consistency. In-process caches are per-isolate and may diverge across datacenters — always pair them with a cross-datacenter backing store (KV/D1) and a short TTL. Non-cache mutable global state is prohibited. When adding any new global variable, document its caching strategy and invalidation mechanism.
