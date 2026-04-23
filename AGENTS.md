# AGENTS.md

## Prime Directive

If you are an AI agent asked to open a Pull Request for this repository, you
must get explicit approval from a real human first. The human must confirm that
they:

1. Understand the goal and risks of the change.
2. Have read every line of AI-generated code, plus the PR title and description.
3. Believe the code, docs, and tests are internally consistent and meet the
   project bar.

AI-generated contributions are welcome. Unreviewed AI-generated Pull Requests
are not.

## Project Snapshot

`copilot-gateway` is a GitHub Copilot API proxy. It exposes standard Anthropic
Messages, OpenAI Responses, and OpenAI Chat Completions interfaces on top of
Copilot upstream APIs so tools like Claude Code and Codex CLI can use a Copilot
subscription.

Runtime stack:

- Cloudflare Workers
- Hono + Web APIs
- D1 for persistence
- `deno test` for tests

## Architecture

High-level layering:

```text
HTTP routes
  -> app/service logic
  -> repo interfaces
  -> D1 implementation
```

Important files:

- `entry-cloudflare.ts`: Workers entrypoint, env + repo initialization.
- `src/app.ts`: Hono app wiring, middleware, route registration.
- `src/lib/env.ts`: pluggable env access.
- `src/repo/types.ts`: repo interfaces.
- `src/repo/d1.ts`: D1-backed repo.
- `src/repo/memory.ts`: in-memory repo for tests.

Global caches:

- `src/lib/copilot.ts`: Copilot token cache, L1 in-process + L2 repo-backed.
- `src/lib/models-cache.ts`: model capability cache, L1 in-process + L2
  repo-backed.
- `src/lib/probe.ts` + `src/lib/copilot-probes.ts`: cached capability probes for
  request-shape behavior not reliably exposed by `/models`.

### Control Plane vs Data Plane

Control plane:

- `/auth/*`
- `/api/*`
- `/dashboard`

Data plane:

- `/v1/messages`
- `/v1/responses`
- `/v1/chat/completions`
- `/v1/embeddings`
- `/v1/models`
- `/v1/messages/count_tokens`

Translation, stream handling, and Copilot workarounds belong to the data plane
only.

### Data Plane Shape

The data plane is organized under `src/data-plane/`.

Top-level structure is role-organized:

- `src/data-plane/sources/`
- `src/data-plane/targets/`
- `src/data-plane/translate/`
- `src/data-plane/shared/`

`src/app.ts` mounts the three main data-plane source entries directly:

- `serveMessages`
- `serveResponses`
- `serveChatCompletions`

Do not reintroduce separate route wrapper files for these three APIs unless a
real new boundary appears.

Each source API has one unique entry:

- `serveMessages`
- `serveResponses`
- `serveChatCompletions`

Each source entry follows the same pipeline:

```text
serve
  -> normalize
  -> plan
  -> build
  -> emit
  -> translate events
  -> respond
```

Use these terms. Do not invent a second vocabulary for the same pipeline.

The successful response path is unified as source-shaped event streams after
`emit`. That internal contract is event-first, not raw SSE-text-only.

Each upstream target endpoint also has one unique emitter:

- `emitToMessages`
- `emitToResponses`
- `emitToChatCompletions`

All target-specific request fixes, response fixes, and retry/workaround logic
for the same upstream endpoint should be centralized in that target subtree.

Boundary-owned workarounds are interceptor-driven:

- target emit interceptors live under
  `src/data-plane/targets/<target>/interceptors/`
- source respond/result interceptors live under
  `src/data-plane/sources/<source>/interceptors/`
- each such directory owns one `index.ts` registration array; change that array
  when adding, removing, or reordering interceptors

Keep the main `emit.ts` and `respond.ts` flows stable. Workaround churn should
mostly stay inside interceptor files and their registration arrays.

Target and source interceptors are intentionally different:

- target interceptors wrap the upstream attempt and may patch request, inspect
  errors, retry, and patch event results
- source interceptors transform already-produced source-shaped results before
  final HTTP response shaping

### Pairwise Translation Rule

Do not introduce a canonical internal IR for requests.

- Request translation stays direct and pairwise.
- Response handling is event-first.
- Non-stream client responses should be assembled from source-shaped event
  streams whenever practical.

## Authentication and Authorization

There are two roles:

- `admin`: authenticated by `ADMIN_KEY`
- API key user: authenticated by an API key created by admin

Rules that matter most:

- `GET /api/keys`: admin sees all keys; API key user sees only their own key.
- Mutating key APIs are admin-only.
- `GET /api/token-usage` is intentionally visible to any authenticated user.
- GitHub account management, Copilot quota, export, and import are admin-only.

## Route Inventory

All OpenAI-compatible routes are exposed at both `/v1/...` and `/...`.

Primary proxy routes:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `GET /v1/models`
- `POST /v1/embeddings`

## Data Plane Routing Rules

`/v1/messages` chooses among:

1. Native `/v1/messages`
2. Translated `/responses`
3. Translated `/chat/completions`

`/v1/responses` chooses among:

1. Native `/responses`
2. Translated `/v1/messages`

`/v1/chat/completions` chooses among:

1. Translated `/v1/messages`
2. Translated `/responses`
3. Native `/chat/completions`

Planning is the only layer allowed to make this routing decision.

## Data Plane Workarounds

Keep workarounds in the layer that owns the boundary where they apply.

Current placement:

- `src/data-plane/sources/messages/normalize/`
  - strip `x-anthropic-billing-header` prompt attribution
  - strip `cache_control.scope`
  - remove unsupported `web_search` tools
- `src/data-plane/sources/messages/interceptors/rewrite-context-window-error.ts`
  - rewrite upstream context-window errors into the Anthropic compact
    `invalid_request_error` envelope expected by Messages clients
- `src/data-plane/sources/responses/normalize/`
  - rewrite `apply_patch` from `custom` to `function`
- `src/data-plane/targets/messages/interceptors/filter-invalid-thinking-blocks.ts`
  - filter invalid thinking blocks
- `src/data-plane/targets/messages/interceptors/fix-anthropic-beta.ts`
  - whitelist `anthropic-beta`
  - auto-add `interleaved-thinking-2025-05-14` when required
- `src/data-plane/targets/messages/interceptors/strip-service-tier.ts`
  - strip unsupported `service_tier`
- `src/data-plane/targets/messages/interceptors/strip-done-sentinel.ts`
  - strip stray `[DONE]` sentinels
- `src/data-plane/targets/responses/interceptors/retry-connection-mismatch.ts`
  - detect expired connection-bound input IDs
  - deterministically rewrite IDs
  - retry once
- `src/data-plane/targets/responses/interceptors/synchronize-output-item-ids.ts`
  - synchronize mismatched stream item IDs
- `src/data-plane/targets/chat-completions/interceptors/include-usage-stream-options.ts`
  - ensure streaming usage options needed by native chat handling
- `src/data-plane/targets/chat-completions/interceptors/fix-claude-choice-shape.ts`
  - merge Claude split choices
  - normalize streaming choice indices
- shared translation event helpers
  - guard against infinite whitespace in tool/function arguments

Do not spread the same workaround across route handlers, target emitters, and
translation code at the same time.

## Error Policy

Prefer transparent error propagation.

- Preserve upstream status, headers, and body as directly as possible.
- Do not add explanatory text to upstream errors unless a specific source- or
  target-level workaround requires inspecting and branching on that error.
- Internal failures must expose debug information, including stack traces.
- Use explicit result unions for expected control flow. Do not rely on
  exceptions for ordinary branching.

For source-specific envelopes, keep the source API contract, but still expose
full internal debug fields.

## Testing and Verification

Primary commands:

```bash
deno test
wrangler dev
wrangler deploy
wrangler d1 migrations apply copilot-db
```

Before claiming work is complete, run the relevant verification command and read
the result. Do not claim success from inspection alone.

## Workflow Rules

- Do not create commits unless the human explicitly asks for a commit.
- If the human wants deploy-before-commit validation, deploy first and leave
  changes uncommitted until they approve the commit.
- Keep `AGENTS.md` aligned with real architecture and workflow. Rewrite when
  needed; do not accrete contradictory additions.
- When replacing a design, remove dead paths, stale fallbacks, and unused
  compatibility residue unless a real migration reason requires keeping them.
- Any new mutable global state must be treated as edge-distributed state: pair
  in-process caches with a cross-datacenter backing store and document
  invalidation.

## Code Style

These rules apply project-wide, not only to the data plane.

### General

- Prefer functional style.
- Prefer arrow functions.
- Prefer concise expression-bodied functions when that does not hurt clarity.
- Prefer many focused files over one large file that will accumulate unrelated
  logic.
- Use double quotes and semicolons.

### Abstraction

- Do not extract tiny one-off helpers unless they encode a real domain rule, are
  reused, materially simplify a flow, or need isolated tests.
- Do not introduce framework-like generic layers when a direct explicit flow is
  clearer.
- When the code is already short and readable, keep it inline.

### Fallback Semantics

- Be strict with fallback semantics such as `?? ""`, `?? []`, or synthetic
  default objects.
- Add defaults only when required by a spec, an upstream contract, or an
  explicit behavior decision.
- Do not silently fill values just to make types or branches convenient.

### Exceptions and Branching

- Avoid `catch` for normal control flow.
- Use `catch` only at real boundaries: fetch, parsing, probing, top-level
  request guards, and explicit workaround retry boundaries.
- Avoid defensive checks for cases already excluded by types, normalization, or
  planning.

### Errors

- Preserve upstream errors instead of rewriting them into vague gateway text.
- Internal error responses must include useful debug context, especially stack
  traces.
- Prefer explicit discriminated unions over exception-driven flow for expected
  runtime states.

### Comments

- Do not add comments that merely restate code.
- Do add comments for non-obvious decisions, upstream quirks, protocol
  mismatches, references, or constraints the code alone cannot explain.
- Every explicit workaround, compatibility shim, retry-once branch, or upstream
  quirk fix must carry a nearby comment explaining why it exists, why it lives
  at that boundary, and what it is referencing.
- Local historical commits and issues are good references for those comments.
- Do not cite local markdown docs as workaround references inside code comments.
- When referencing another project's file or commit in a code comment, use a
  permalink URL, not a floating branch path.
- In `References:` lists and similar workaround citations, do not wrap URLs in
  backticks.
- Do not use section-divider comments as a substitute for proper file and
  function structure.

### Type Discipline

- Prefer discriminated unions and narrowing over assertions.
- If an assertion is truly necessary for external payloads or weak runtime
  contracts, keep it narrow and local.
- Keep literal `type` fields literal so narrowing stays useful.

## File Structure Guidance

- New data-plane work belongs in `src/data-plane/`.
- Source-specific work belongs in `src/data-plane/sources/<source>/`.
- Source-owned result fixes belong in
  `src/data-plane/sources/<source>/interceptors/` and are registered in that
  directory's `index.ts`.
- Shared target-specific logic belongs in `src/data-plane/targets/<target>/`.
- Target-owned request/response/retry fixes belong in
  `src/data-plane/targets/<target>/interceptors/` and are registered in that
  directory's `index.ts`.
- Pairwise translators belong in `src/data-plane/translate/`.
- Source-specific request cleanup, planning, response assembly, and
  orchestration belong under that source API's subtree.
- Keep final source protocol collection and response shaping source-local.
- If you are reorganizing pair modules, prefer
  `src/data-plane/translate/<source>-via-<target>/` over split request/event
  directories.

When in doubt, prefer the location that matches the boundary where the logic is
true.
