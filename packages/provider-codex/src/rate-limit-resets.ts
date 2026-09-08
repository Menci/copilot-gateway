import {
  CODEX_BACKEND_BASE,
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_PATH,
  CODEX_RATE_LIMIT_RESET_CREDITS_PATH,
  CODEX_USER_AGENT,
} from './constants.ts';
import { jsonRequestBody, type Fetcher } from '@floway-dev/provider';

// Keep the backend's open-string values intact. The official app-server maps
// unknown reset types and statuses onto `unknown`, but Floway is already the
// wire boundary and must not discard a future value the operator may need to
// diagnose:
// https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L305-L361
export interface CodexRateLimitResetCredit {
  id: string;
  reset_type: string;
  status: string;
  granted_at: string;
  expires_at: string | null;
  title: string | null;
  description: string | null;
}

export interface CodexRateLimitResetCredits {
  available_count: number;
  credits: CodexRateLimitResetCredit[];
}

export interface CodexRateLimitResetOutcome {
  code: string;
}

export class CodexRateLimitResetRequestError extends Error {
  constructor(
    readonly operation: 'list' | 'consume',
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Codex reset-credit ${operation} failed: ${status} ${responseBody.slice(0, 200)}`);
    this.name = 'CodexRateLimitResetRequestError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (record: Record<string, unknown>, key: string, where: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${where}.${key} must be a non-empty string`);
  }
  return value;
};

const nullableString = (record: Record<string, unknown>, key: string, where: string): string | null => {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${where}.${key} must be a string or null`);
  return value;
};

const instantString = (record: Record<string, unknown>, key: string, where: string, nullable: boolean): string | null => {
  const value = nullable ? nullableString(record, key, where) : requiredString(record, key, where);
  if (value !== null && !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${where}.${key} must be a valid date-time string${nullable ? ' or null' : ''}`);
  }
  return value;
};

export const parseCodexRateLimitResetCredits = (value: unknown): CodexRateLimitResetCredits => {
  if (!isRecord(value)) throw new TypeError('Codex reset-credit response must be an object');
  if (!Number.isSafeInteger(value.available_count) || (value.available_count as number) < 0) {
    throw new TypeError('Codex reset-credit response.available_count must be a non-negative integer');
  }
  if (!Array.isArray(value.credits)) throw new TypeError('Codex reset-credit response.credits must be an array');
  const credits = value.credits.map((entry, index): CodexRateLimitResetCredit => {
    const where = `Codex reset-credit response.credits[${index}]`;
    if (!isRecord(entry)) throw new TypeError(`${where} must be an object`);
    return {
      id: requiredString(entry, 'id', where),
      reset_type: requiredString(entry, 'reset_type', where),
      status: requiredString(entry, 'status', where),
      granted_at: instantString(entry, 'granted_at', where, false)!,
      expires_at: instantString(entry, 'expires_at', where, true),
      title: nullableString(entry, 'title', where),
      description: nullableString(entry, 'description', where),
    };
  });
  return { available_count: value.available_count as number, credits };
};

export const parseCodexRateLimitResetOutcome = (value: unknown): CodexRateLimitResetOutcome => {
  if (!isRecord(value)) throw new TypeError('Codex reset-credit consume response must be an object');
  return { code: requiredString(value, 'code', 'Codex reset-credit consume response') };
};

const headersFor = (accessToken: string, accountId: string): Headers => new Headers({
  authorization: `Bearer ${accessToken}`,
  'chatgpt-account-id': accountId,
  'user-agent': CODEX_USER_AGENT,
  accept: 'application/json',
});

const jsonFrom = async (response: Response, operation: 'list' | 'consume'): Promise<unknown> => {
  const body = await response.text();
  if (!response.ok) throw new CodexRateLimitResetRequestError(operation, response.status, body);
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    throw new Error(`Codex reset-credit ${operation} returned malformed JSON`, { cause });
  }
};

export const fetchCodexRateLimitResetCredits = async (opts: {
  accessToken: string;
  accountId: string;
  fetcher: Fetcher;
  signal?: AbortSignal;
}): Promise<CodexRateLimitResetCredits> => {
  const response = await opts.fetcher(`${CODEX_BACKEND_BASE}${CODEX_RATE_LIMIT_RESET_CREDITS_PATH}`, {
    method: 'GET',
    headers: headersFor(opts.accessToken, opts.accountId),
    signal: opts.signal,
  });
  return parseCodexRateLimitResetCredits(await jsonFrom(response, 'list'));
};

export const consumeCodexRateLimitResetCredit = async (opts: {
  accessToken: string;
  accountId: string;
  creditId: string;
  idempotencyKey: string;
  fetcher: Fetcher;
  signal?: AbortSignal;
}): Promise<CodexRateLimitResetOutcome> => {
  const headers = headersFor(opts.accessToken, opts.accountId);
  headers.set('content-type', 'application/json');
  const response = await opts.fetcher(`${CODEX_BACKEND_BASE}${CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_PATH}`, {
    method: 'POST',
    headers,
    body: jsonRequestBody({ redeem_request_id: opts.idempotencyKey, credit_id: opts.creditId }),
    signal: opts.signal,
  });
  return parseCodexRateLimitResetOutcome(await jsonFrom(response, 'consume'));
};
