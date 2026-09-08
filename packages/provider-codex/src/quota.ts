import { findCodexAccountIndex, readCodexUpstreamState, replaceCodexAccount } from './state.ts';
import { getProviderRepo } from '@floway-dev/provider';

export interface CodexQuotaSnapshot {
  observed_at: string;
  active_limit?: string;
  plan_type?: string;

  primary_used_percent?: number;
  primary_window_minutes?: number;
  primary_reset_after_at?: string;

  secondary_used_percent?: number;
  secondary_window_minutes?: number;
  secondary_reset_after_at?: string;

  credits_has_credits?: boolean;
  credits_balance?: number;

  // Present only when this snapshot was written as a result of a 429.
  ratelimited_until?: string;
}

export type CodexQuotaSnapshotMap = Record<string, CodexQuotaSnapshot>;

export const CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT = 'unknown';

const isUnsafeActiveLimitKey = (key: string): boolean => key === '__proto__' || key === 'constructor' || key === 'prototype';

export const codexQuotaActiveLimitKey = (snapshot: CodexQuotaSnapshot): string => {
  const key = snapshot.active_limit?.trim();
  return key && !isUnsafeActiveLimitKey(key) ? key : CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT;
};

interface ParseCodexQuotaOptions {
  now: Date;
  isRateLimited: boolean;
}

export const parseCodexQuotaHeaders = (headers: Headers, options: ParseCodexQuotaOptions): CodexQuotaSnapshot => {
  const snapshot: CodexQuotaSnapshot = { observed_at: options.now.toISOString() };
  const assign = snapshot as unknown as Record<string, unknown>;

  const setString = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const trimmed = v.trim();
    if (trimmed !== '') assign[key] = trimmed;
  };
  const setNumber = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    // Blank rather than absent is how this backend reports a field that does
    // not apply -- a plan with no secondary window, an account with no credit
    // balance -- and `Number('')` is 0, which would render as a confident zero.
    if (v.trim() === '') return;
    const n = Number(v);
    if (Number.isFinite(n)) assign[key] = n;
  };
  const setBool = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const lower = v.toLowerCase();
    if (lower === 'true') assign[key] = true;
    else if (lower === 'false') assign[key] = false;
  };
  // Upstream renamed this reading on 2025-10-17: `-reset-at` states the instant
  // outright, where `-reset-after-seconds` states the offset from receipt. Both
  // are still sent, and a capture from 2025-09 carries only the offset, so the
  // rename added a header rather than replacing one. The instant is preferred
  // and the offset is the fallback, which is the shape the third-party clients
  // that read both settled on -- and which keeps this working on the day the
  // offset stops being sent.
  // https://github.com/openai/codex/commit/0e08dd605
  //
  // Zero and blank both mean "this plan has no such window" rather than "it
  // resets now": a capture pairs a blank `-reset-at` with a zero
  // `-reset-after-seconds` on a plan whose secondary window is 0 minutes wide.
  const resetInstant = (prefix: string): string | undefined => {
    const at = headers.get(`${prefix}-reset-at`)?.trim();
    if (at !== undefined && at !== '') {
      const epochSeconds = Number(at);
      // Epoch seconds today; RFC 3339 in builds from the three days after the
      // header landed, which is why clients that read it accept both.
      const instant = Number.isFinite(epochSeconds) ? epochSeconds * 1000 : Date.parse(at);
      if (Number.isFinite(instant) && instant > 0) return new Date(instant).toISOString();
    }
    const after = headers.get(`${prefix}-reset-after-seconds`)?.trim();
    if (after === undefined || after === '') return undefined;
    const seconds = Number(after);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return new Date(options.now.getTime() + seconds * 1000).toISOString();
  };

  const setReset = (key: keyof CodexQuotaSnapshot, prefix: string): void => {
    const instant = resetInstant(prefix);
    if (instant !== undefined) assign[key] = instant;
  };

  setString('active_limit', 'x-codex-active-limit');
  setString('plan_type', 'x-codex-plan-type');
  setNumber('primary_used_percent', 'x-codex-primary-used-percent');
  setNumber('primary_window_minutes', 'x-codex-primary-window-minutes');
  setReset('primary_reset_after_at', 'x-codex-primary');
  setNumber('secondary_used_percent', 'x-codex-secondary-used-percent');
  setNumber('secondary_window_minutes', 'x-codex-secondary-window-minutes');
  setReset('secondary_reset_after_at', 'x-codex-secondary');
  setBool('credits_has_credits', 'x-codex-credits-has-credits');
  setNumber('credits_balance', 'x-codex-credits-balance');

  // The furthest window is when the block lifts, read through the same
  // preference so a response carrying only the new header still dates it.
  if (options.isRateLimited) {
    const horizons = [snapshot.primary_reset_after_at, snapshot.secondary_reset_after_at]
      .filter((instant): instant is string => instant !== undefined)
      .map(instant => Date.parse(instant))
      .filter(Number.isFinite);
    if (horizons.length > 0) {
      snapshot.ratelimited_until = new Date(Math.max(...horizons)).toISOString();
    }
  }

  return snapshot;
};

export const hasCodexQuotaReading = (snapshot: CodexQuotaSnapshot): boolean => {
  const { observed_at: _observationTime, ...reading } = snapshot;
  return Object.keys(reading).length > 0;
};

// Every quota snapshot this account has observed, keyed by active limit.
//
// No TTL, which is the rule the other three providers state at their own slots:
// a reading rendered with the instant it was taken tells an operator more than
// an empty card does, and any traffic on the upstream replaces it. Only the
// dashboard reads this -- the data plane routes without consulting it -- so
// withholding a reading buys nothing and costs the page the only answer it has.
export const getCodexQuota = async (
  upstreamId: string,
  accountId: string,
): Promise<CodexQuotaSnapshotMap | null> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) return null;
  const state = readCodexUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.chatgptAccountId === accountId);
  const snapshots = account?.quotaSnapshot;
  if (!snapshots || Object.keys(snapshots).length === 0) return null;
  return Object.fromEntries(Object.entries(snapshots).map(([key, entry]) => [key, entry.data]));
};

export const putCodexQuota = async (
  upstreamId: string,
  accountId: string,
  snapshot: CodexQuotaSnapshot,
): Promise<void> => {
  // Stamped before the write so a replay against a winning sibling produces
  // the same document rather than a later `fetchedAt`.
  const fetchedAt = Date.now();
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readCodexUpstreamState(current);
    const idx = findCodexAccountIndex(state, accountId);
    if (idx < 0) throw new Error(`putCodexQuota: Codex account ${accountId} not found in upstream ${upstreamId}`);
    return replaceCodexAccount(state, idx, account => ({
      ...account,
      quotaSnapshot: { ...account.quotaSnapshot ?? {}, [codexQuotaActiveLimitKey(snapshot)]: { fetchedAt, data: snapshot } },
    }));
  });
};

// A successful earned reset invalidates every locally observed window. Do not
// synthesize zeroes: OpenAI explicitly requires clients to refetch limits after
// redemption, and the next Codex response will repopulate the same slot.
// https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#8-earned-rate-limit-resets-chatgpt
export const clearCodexQuota = async (
  upstreamId: string,
  accountId: string,
): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readCodexUpstreamState(current);
    const idx = findCodexAccountIndex(state, accountId);
    if (idx < 0) throw new Error(`clearCodexQuota: Codex account ${accountId} not found in upstream ${upstreamId}`);
    if (state.accounts[idx].quotaSnapshot === null) return current;
    return replaceCodexAccount(state, idx, account => ({ ...account, quotaSnapshot: null }));
  });
};
