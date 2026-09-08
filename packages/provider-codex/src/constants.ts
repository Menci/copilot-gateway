// All Codex / ChatGPT upstream constants. Keep the data-plane identity fixed
// to the official Codex CLI shape. Do not add Floway/operator attribution as a
// product token or trailing User-Agent suffix.

// codex-cli's OAuth client id. Used at auth.openai.com for both authorize and
// token-exchange. Same value across the canonical Codex CLI source and every
// independent reimplementation surveyed on GitHub:
// https://github.com/openai/codex/blob/87b808bb570f01f4b6fc8485c5459052fac0e320/codex-rs/login/src/auth/manager.rs
// https://github.com/170-carry/codex-tools/blob/0b0910b2b5351372e9ece1a82b3d5ea2ce7c3da5/src-tauri/src/auth.rs
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

// Fixed redirect URI registered against CODEX_CLIENT_ID at OpenAI.
// Cannot be changed without re-registering the OAuth client.
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';

// OAuth scope minimum-confirmed across implementations. We do NOT request the
// connector scopes (api.connectors.read / .invoke) — they are only needed for
// the MCP-connector feature and unrelated to /codex/responses.
export const CODEX_OAUTH_SCOPE = 'openid profile email offline_access';

// OAuth User-Agent. Pinned independently of the data-plane CODEX_CLI_VERSION:
// `0.91.0` is the version captured by OpenAI when the codex-cli OAuth client
// was first registered, and the auth.openai.com /token + /authorize endpoints
// continue to accept it across CLI revisions (cross-checked against
// sub2api/backend, which is in continuous production use against the same
// endpoints with this exact UA). Note the hyphen-lowercase product name —
// distinct from the underscore form used on the data plane below.
export const CODEX_OAUTH_USER_AGENT = 'codex-cli/0.91.0';

export const CODEX_BACKEND_BASE = 'https://chatgpt.com/backend-api';
export const CODEX_OPENAI_RESPONSES_PATH = '/codex/responses';
// Codex appends `alpha/search` to its ChatGPT model-provider base.
// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs#L31-L47
export const CODEX_ALPHA_SEARCH_PATH = '/codex/alpha/search';
// Native unary compaction endpoint. The Codex CLI defaults to a client-side
// `RemoteCompactionV2` path that re-uses `/codex/responses` with an appended
// `compaction_trigger` item, but the server still serves this canonical
// `/responses/compact` URL — the same one Azure OpenAI and the public
// `api.openai.com` OpenAI Responses surface expose — and the Codex CLI's
// `ApiCompactClient` keeps it as the fallback transport. We prefer the unary
// endpoint so the provider behaves identically to every other
// `/responses/compact` upstream and skips the SSE drain entirely.
// Reference: https://github.com/openai/codex/blob/f5f812389ee49ab4c9ef1237781ea1013e733fdc/codex-rs/core/src/client.rs#L155
export const CODEX_OPENAI_RESPONSES_COMPACT_PATH = '/codex/responses/compact';
export const CODEX_MODELS_PATH = '/codex/models';

// Earned ChatGPT subscription resets are a separate account surface from the
// ordinary Codex data plane. The official Codex backend client selects these
// WHAM paths for chatgpt.com and posts a caller-stable redemption id beside an
// optional opaque credit id:
// https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs#L90-L130
export const CODEX_RATE_LIMIT_RESET_CREDITS_PATH = '/wham/rate-limit-reset-credits';
export const CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_PATH = '/wham/rate-limit-reset-credits/consume';

// Codex's image extension does not discover this model through /codex/models.
// It owns the capability and sends the fixed model id to these provider-
// relative endpoints instead.
// https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/ext/image-generation/src/tool.rs#L51-L59
// https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/codex-api/src/endpoint/images.rs#L33-L70
export const CODEX_IMAGE_MODEL_ID = 'gpt-image-2';
export const CODEX_OPENAI_IMAGES_GENERATIONS_PATH = '/codex/images/generations';
export const CODEX_OPENAI_IMAGES_EDITS_PATH = '/codex/images/edits';

// codex_cli_rs version we impersonate on the data plane. Bumped against the
// latest stable release at https://github.com/openai/codex/releases — newer entries in
// /codex/models gate themselves behind a `minimal_client_version` (e.g.
// the gpt-5.6 Sol / Terra / Luna family needs 0.144.0+), so a stale value
// here silently truncates the model list. The same value flows into both
// the `?client_version=` query param and the User-Agent so the upstream sees
// a self-consistent client.
export const CODEX_CLI_VERSION = '0.144.1';

// Shared official Codex data-plane identity for /codex/models and
// /codex/responses. The User-Agent intentionally includes Codex's normal
// OS/arch/terminal segment; do not append Floway/operator/MCP attribution.
export const CODEX_ORIGINATOR = 'codex_cli_rs';
export const CODEX_USER_AGENT =
  `codex_cli_rs/${CODEX_CLI_VERSION} (Mac OS 26.5.0; arm64) iTerm.app/3.6.10`;
