# Data Plane Translation

## Overview

`copilot-gateway` exposes three client-facing data plane APIs:

- `POST /v1/messages` — Anthropic Messages compatible endpoint
- `POST /v1/responses` — OpenAI Responses compatible endpoint
- `POST /v1/chat/completions` — OpenAI Chat Completions endpoint

Route selection is driven by `GET /models` capability data, specifically each
model's `supported_endpoints`. The only model-name fallback is the legacy Chat
Completions behavior for models without any usable capability-backed target.
The gateway does not runtime-probe request-shape support; once a target endpoint
is selected, request validation is generally left to that upstream endpoint.

## `/v1/messages` Routing

File: `src/data-plane/llm/sources/messages/serve.ts`

The Messages route selects one of three paths:

1. Native Messages If the model supports `/v1/messages`, forward the Anthropic
   payload directly.
2. Responses translation If the model does not support `/v1/messages`, but
   supports `/responses`, translate Anthropic Messages ↔ OpenAI Responses.
3. Chat Completions translation Otherwise, translate Anthropic Messages ↔ OpenAI
   Chat Completions.

Current behavior:

- Anthropic tool `strict` is forwarded as-is on native `/v1/messages`.
- The gateway does not silently drop `strict` and does not reroute strict
  Messages requests to `/chat/completions`.
- If the upstream native Messages endpoint rejects `strict`, that `400` error is
  returned to the client.

## Native Messages Path

File: `src/data-plane/llm/sources/messages/serve.ts`

When forwarding to native `/v1/messages`, the gateway applies only compatibility
workarounds that preserve Anthropic semantics:

- strip unsupported `web_search` tools
- strip reserved keyword `x-anthropic-billing-header` from text blocks
- filter invalid GPT-origin thinking blocks before native forwarding
- whitelist forwarded `anthropic-beta` values
- auto-add `interleaved-thinking-2025-05-14` for budget-based thinking when
  appropriate
- remove unsupported `service_tier`
- filter stray SSE `data: [DONE]` sentinels so the stream remains Anthropic
  shaped

The gateway does not inject `adaptive` thinking mode.

## Messages ↔ Chat Completions Translation

Files:

- `src/lib/translate/messages-to-chat-completions.ts`
- `src/lib/translate/messages-to-chat-completions-stream.ts`
- `src/lib/translate/chat-completions-to-messages.ts`
- `src/lib/translate/chat-completions-to-messages-stream.ts`

This path is used only when native `/v1/messages` is unavailable.

### Anthropic Messages → Chat Completions

Main mappings:

- `system` becomes a leading Chat Completions system message
- Anthropic `text` blocks become assistant `content`
- Anthropic `tool_use` blocks become OpenAI `tool_calls`
- Anthropic `thinking` / `redacted_thinking` become `reasoning_text` /
  `reasoning_opaque`
- Anthropic tool definitions become OpenAI function tools
- Anthropic `tool_choice` maps to OpenAI `tool_choice`
- Anthropic `stop_reason` maps to OpenAI `finish_reason`

### Chat Completions → Anthropic Messages

Main mappings:

- system/developer messages are collected into top-level Anthropic `system`
- user / assistant / tool messages are regrouped into alternating Anthropic
  messages
- assistant blocks are ordered as `thinking` → `text` → `tool_use`
- OpenAI JSON-string tool arguments are parsed into Anthropic `input` objects
- `reasoning_text` / `reasoning_opaque` become Anthropic thinking blocks
- image parts are converted to Anthropic image blocks when possible

### Chat Completions Streaming

OpenAI streams use bare `data:` chunks and end with `[DONE]`. When translating
Chat Completions → Anthropic, the gateway consumes OpenAI chunks and emits
Anthropic SSE events such as:

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`

## Messages ↔ Responses Translation

Files:

- `src/lib/translate/messages-to-responses.ts`
- `src/lib/translate/messages-to-responses-stream.ts`
- `src/lib/translate/responses-to-messages.ts`
- `src/lib/translate/responses-to-messages-stream.ts`

This path is used whenever native `/v1/messages` is unavailable and the model
supports `/responses`. The `/chat/completions` translation path is only used for
Messages requests when `/responses` is unavailable.

Main mappings:

- Anthropic system/developer content is normalized into Responses input items
- Anthropic tool definitions become Responses function tools
- Anthropic reasoning/thinking content is preserved using Responses reasoning
  items and encrypted content round-tripping
- `output_config.effort` maps directly to `reasoning.effort`
- `thinking: { type: "disabled" }` maps directly to
  `reasoning: { effort: "none" }`
- other Anthropic `thinking` states have no Responses request counterpart and
  are ignored on request translation
- Anthropic SSE is translated into named Responses SSE events with
  `sequence_number` and stable output item IDs

## `/v1/responses` Routing

File: `src/data-plane/llm/sources/responses/serve.ts`

The Responses route selects one of three paths:

1. Native Responses if the model supports `/responses`
2. Reverse translation through Anthropic Messages if `/responses` is
   unavailable and the model supports `/v1/messages`
3. Reverse translation through Chat Completions if neither `/responses` nor
   `/v1/messages` is available and the model supports `/chat/completions`

## `/v1/chat/completions` Routing

File: `src/data-plane/llm/sources/chat-completions/serve.ts`

The Chat Completions route selects one of three capability-backed paths:

1. Messages translation. If the model supports `/v1/messages`, translate Chat
   Completions ↔ Anthropic Messages (reuses the Messages translation layer).
2. Native Chat Completions. If the model supports `/chat/completions`, forward
   the request directly.
3. Responses translation. If neither `/v1/messages` nor `/chat/completions` is
   available and the model supports `/responses`, translate Chat Completions ↔
   Responses directly (no Anthropic intermediate).

Unknown Chat Completions fields are only preserved on the native
`/chat/completions` route. Translated paths only carry fields with explicit
pairwise mappings.

If no capability-backed target is available, the route keeps its legacy fallback:
`claude*` model names route through Anthropic Messages, and other model names
route through native Chat Completions.

## Chat Completions ↔ Responses Translation

Files:

- `src/lib/translate/chat-completions-to-responses.ts`
- `src/lib/translate/responses-to-chat-completions.ts`

This path is used when a model accessed via `/chat/completions` only supports
the `/responses` endpoint. Translation is direct — no Anthropic intermediate
format.

### Chat Completions → Responses (request)

- system/developer messages → `instructions`
- user messages → Responses `message` input items
- assistant text → `output_text` content blocks
- assistant `tool_calls` → separate `function_call` input items
- `reasoning_text`/`reasoning_opaque` → `reasoning` input items
- tool messages → `function_call_output` input items
- tools → Responses `function` tools

### Responses → Chat Completions (response)

- `message` output items → `content` string
- `function_call` output items → `tool_calls` array
- `reasoning` output items → `reasoning_text` / `reasoning_opaque`
- status mapping: `completed` → `stop`/`tool_calls`, `incomplete` → `length`

### Streaming (Responses → Chat Completions)

Responses SSE events are translated directly to Chat Completions chunks:

- `response.created` → initial chunk with `role: "assistant"`
- `response.output_text.delta` → `content` delta
- `response.function_call_arguments.delta` → `tool_calls` arguments delta
- `response.reasoning_summary_text.delta` → `reasoning_text` delta
- `response.output_item.done` (reasoning) → `reasoning_opaque` (signature)
- `response.completed`/`response.incomplete` → final chunk with
  `finish_reason` + `usage`

## Key Current Constraints

- Native Anthropic-compatible streams must not expose `[DONE]`.
- `strict` support on Copilot upstream Claude models is inconsistent; the
  gateway intentionally does not mask this with implicit fallback.
- `count_tokens` proxies directly to the Copilot upstream
  `/v1/messages/count_tokens` endpoint.

## Translation-Induced Limitations

Cross-format translation is inherently lossy. The following limitations are
known and accepted trade-offs.

Token-cap adjustments that only exist to satisfy a chosen upstream endpoint are
kept in target-side interceptors, not pairwise translators.

### Messages ↔ Responses

**Request parameters lost or approximated (Messages → Responses):**

| Parameter        | Behavior                                                                    |
| ---------------- | --------------------------------------------------------------------------- |
| `temperature`    | Hardcoded to `1` (reasoning models require it)                              |
| `budget_tokens`  | Dropped — this gateway does not synthesize a Responses request value for it |
| `effort: "max"`  | Preserved as-is and left to the upstream Responses endpoint to validate     |
| `stop_sequences` | Dropped — no Responses API counterpart                                      |
| `top_k`          | Dropped — no Responses API counterpart                                      |
| `service_tier`   | Dropped — no Responses API counterpart                                      |

**Reasoning round-trip:**

- `reasoning.id` is **not preserved** across translations. Anthropic thinking
  blocks have no `id` field, and the API rejects extra fields on thinking blocks
  (`Extra inputs are not permitted`). A synthetic id is generated each time.
  This may cause Responses API prompt cache misses when the upstream compares
  reasoning ids for cache key matching. Ref: upstream
  [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api) uses
  `encrypted_content@id` encoding in `signature` to work around this, but that
  corrupts the signature for native Anthropic API
  ([#63](https://github.com/caozhiyuan/copilot-api/issues/63),
  [#73](https://github.com/caozhiyuan/copilot-api/issues/73)).
- `encrypted_content` is mapped directly to/from `signature`. These are the same
  underlying opaque token from the model backend.

### Messages ↔ Chat Completions

**Request parameters lost or approximated (Messages → Chat Completions):**

| Parameter        | Behavior                                  |
| ---------------- | ----------------------------------------- |
| `stop_sequences` | Mapped to `stop` — semantics preserved    |
| `top_k`          | Dropped — no Chat Completions counterpart |
| `service_tier`   | Dropped — no Chat Completions counterpart |

**Content structure:**

- Multiple thinking blocks in assistant messages are merged into a single
  `reasoning_text` + `reasoning_opaque`. Only the first signature is kept;
  subsequent ones are lost.
- Image blocks in assistant messages are silently dropped (Chat Completions does
  not support assistant-side images).

**Response translation (Chat Completions → Messages):**

- Multiple choices are merged into one Anthropic response. Choice separation and
  index information is lost.
- `output_tokens_details.reasoning_tokens` is dropped — Anthropic usage has no
  counterpart for reasoning token breakdown.

### Chat Completions → Messages (reverse, for `/v1/messages` fallback)

- `message.name` field is dropped — no Anthropic counterpart.
- Image `detail` level (`"low"` / `"high"` / `"auto"`) is dropped; all images
  use default detail.
- Remote image fetch failures are silent — the image is dropped with no error
  reported to the client.
- Non-standard image formats (SVG, HEIC, etc.) are silently rejected; only
  `image/jpeg`, `image/png`, `image/gif`, `image/webp` are accepted.

### Chat Completions ↔ Responses

**Request parameters lost or approximated (Chat Completions → Responses):**

| Parameter | Behavior                               |
| --------- | -------------------------------------- |
| `stop`    | Dropped — no Responses API counterpart |

**Reasoning round-trip:**

- `reasoning_text`/`reasoning_opaque` from Chat Completions history are mapped
  to Responses `reasoning` input items and back, preserving `encrypted_content`
  for signature round-tripping.

### Streaming-Specific

- `signature_delta` events from Anthropic streams are captured but not
  re-emitted as separate Responses stream events. The encrypted content is only
  available in the final `output_item.done` event.
- Responses API `summary_index` is always `0`. Multiple reasoning segments
  within a single response cannot be distinguished.
- `output_text` in the final Responses result is globally accumulated, not
  per-item. Text from separate message output items is concatenated.

## Key Files

- `src/data-plane/llm/sources/messages/serve.ts`
- `src/data-plane/llm/sources/responses/serve.ts`
- `src/data-plane/llm/sources/chat-completions/serve.ts`
- `src/data-plane/llm/sources/messages/count-tokens/serve.ts`
- `src/lib/translate/messages-to-chat-completions.ts`
- `src/lib/translate/messages-to-chat-completions-stream.ts`
- `src/lib/translate/chat-completions-to-messages.ts`
- `src/lib/translate/chat-completions-to-messages-stream.ts`
- `src/lib/translate/messages-to-responses.ts`
- `src/lib/translate/messages-to-responses-stream.ts`
- `src/lib/translate/responses-to-messages.ts`
- `src/lib/translate/responses-to-messages-stream.ts`
- `src/lib/translate/chat-completions-to-responses.ts`
- `src/lib/translate/responses-to-chat-completions.ts`
