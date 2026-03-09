const COPILOT_BASE_URLS: Record<string, string> = {
  individual: "https://api.githubcopilot.com",
  business: "https://api.business.githubcopilot.com",
  enterprise: "https://api.enterprise.githubcopilot.com",
};

const COPILOT_VERSION = "0.38.2";
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;
const FALLBACK_EDITOR_VERSION = "vscode/1.110.1";
const API_VERSION = "2025-10-01";

const VSCODE_VERSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
let cachedVSCodeVersion: string | null = null;
let vscodeVersionExpiresAt = 0;

let cachedToken: string | null = null;
let cachedExpiresAt = 0;

export function copilotBaseUrl(accountType: string): string {
  return COPILOT_BASE_URLS[accountType] ?? COPILOT_BASE_URLS.individual;
}

async function fetchVSCodeVersion(): Promise<string> {
  const now = Date.now();
  if (cachedVSCodeVersion && vscodeVersionExpiresAt > now) return cachedVSCodeVersion;

  try {
    const resp = await fetch(
      "https://update.code.visualstudio.com/api/releases/stable",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const releases = (await resp.json()) as string[];
    if (Array.isArray(releases) && releases.length > 0 && typeof releases[0] === "string") {
      cachedVSCodeVersion = releases[0];
      vscodeVersionExpiresAt = now + VSCODE_VERSION_TTL_MS;
      return cachedVSCodeVersion;
    }
    throw new Error("Invalid response format");
  } catch (e) {
    console.warn(`Failed to fetch VS Code version: ${e instanceof Error ? e.message : String(e)}, using fallback`);
    return cachedVSCodeVersion ?? FALLBACK_EDITOR_VERSION.replace("vscode/", "");
  }
}

async function getEditorVersion(): Promise<string> {
  return `vscode/${await fetchVSCodeVersion()}`;
}

export function editorVersion(): string {
  return cachedVSCodeVersion ? `vscode/${cachedVSCodeVersion}` : FALLBACK_EDITOR_VERSION;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e instanceof Error ? e.message : String(e)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

export function getCopilotToken(githubToken: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedExpiresAt > now + 60) return Promise.resolve(cachedToken);

  return withRetry(async () => {
    const editorVer = await getEditorVersion();
    const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        authorization: `token ${githubToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "editor-version": editorVer,
        "editor-plugin-version": EDITOR_PLUGIN_VERSION,
        "user-agent": USER_AGENT,
        "x-github-api-version": API_VERSION,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Copilot token fetch failed: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as { token: string; expires_at: number; refresh_in: number };
    cachedToken = data.token;
    cachedExpiresAt = data.expires_at;
    return data.token;
  });
}

export interface CopilotFetchOptions {
  vision?: boolean;
  initiator?: "user" | "agent";
  extraHeaders?: Record<string, string>;
}

export async function copilotFetch(
  path: string,
  init: RequestInit,
  githubToken: string,
  accountType: string,
  options?: CopilotFetchOptions,
): Promise<Response> {
  const token = await getCopilotToken(githubToken);
  const baseUrl = copilotBaseUrl(accountType);
  const editorVer = await getEditorVersion();

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  headers.set("editor-version", editorVer);
  headers.set("editor-plugin-version", EDITOR_PLUGIN_VERSION);
  headers.set("user-agent", USER_AGENT);
  headers.set("x-github-api-version", API_VERSION);
  headers.set("copilot-integration-id", "vscode-chat");
  headers.set("openai-intent", "conversation-agent");
  headers.set("x-interaction-type", "conversation-agent");

  if (options?.vision) headers.set("copilot-vision-request", "true");
  if (options?.initiator) headers.set("X-Initiator", options.initiator);
  if (options?.extraHeaders) {
    for (const [k, v] of Object.entries(options.extraHeaders)) headers.set(k, v);
  }

  return await fetch(`${baseUrl}${path}`, { ...init, headers });
}

export async function githubHeaders(githubToken: string): Promise<Record<string, string>> {
  const editorVer = await getEditorVersion();
  return {
    authorization: `token ${githubToken}`,
    "content-type": "application/json",
    accept: "application/json",
    "editor-version": editorVer,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "x-github-api-version": API_VERSION,
  };
}
