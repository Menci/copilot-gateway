import { describe, expect, it } from 'vitest';

import type { CodexQuotaSnapshotMap, CodexRateLimitResetCredit, UpstreamRecord } from '../../../src/api/types';
import { accountStatus, codexResetCreditIsUsable, findCredential, latestCredits, quotaEntries } from '../../../src/components/upstreams/codex-account';

type CodexRecord = Extract<UpstreamRecord, { kind: 'codex' }>;

const ACCOUNT_ID = 'acct_0123456789abcdef';
const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const PAST = '2026-07-28T11:00:00.000Z';
const FUTURE = '2026-07-28T13:00:00.000Z';
const activeCredential = { chatgptAccountId: ACCOUNT_ID, state: 'active' as const, state_updated_at: PAST };
const activeLookup = { kind: 'present' as const, credential: activeCredential };

const record = (state: CodexRecord['state'], codexQuota?: CodexQuotaSnapshotMap): CodexRecord => ({
  id: 'up_1',
  kind: 'codex',
  config: { accounts: [{ email: 'a@example.com', chatgptAccountId: ACCOUNT_ID, chatgptUserId: 'u1', planType: 'plus' }] },
  state,
  codex_quota: codexQuota,
} as unknown as CodexRecord);

describe('codex credential lookup', () => {
  it('matches the configured account rather than taking the first stored one', () => {
    const state = {
      accounts: [
        { chatgptAccountId: 'other', state: 'refresh_failed' as const, state_updated_at: PAST },
        { chatgptAccountId: ACCOUNT_ID, state: 'active' as const, state_updated_at: PAST },
      ],
    };
    const lookup = findCredential(record(state));
    expect(lookup.kind).toBe('present');
    if (lookup.kind === 'present') expect(lookup.credential.state).toBe('active');
  });

  it('returns null when the configured account is absent from state', () => {
    expect(findCredential(record({
      accounts: [{ chatgptAccountId: 'other', state: 'active', state_updated_at: PAST }],
    }))).toEqual({ kind: 'account-id-mismatch', expectedAccountId: ACCOUNT_ID });
  });
});

describe('codex quota entries', () => {
  it('reads both windows and orders limits by name', () => {
    const entries = quotaEntries({
      weekly: { observed_at: PAST, active_limit: 'Weekly', primary_used_percent: 20, primary_window_minutes: 10_080 },
      daily: { observed_at: PAST, active_limit: 'Daily', primary_used_percent: 5, secondary_used_percent: 50, secondary_reset_after_at: FUTURE },
    }, NOW);
    expect(entries.map(entry => entry.label)).toEqual(['Daily', 'Weekly']);
    expect(entries[0].windows.map(window => window.key)).toEqual(['primary', 'secondary']);
    expect(entries[0].windows[1]).toMatchObject({ percent: 50, resetAt: FUTURE, windowMinutes: null });
    expect(entries[1].windows).toHaveLength(1);
  });

  it('falls back to the map key when the snapshot names no active limit', () => {
    expect(quotaEntries({ primary: { observed_at: PAST } }, NOW)[0].label).toBe('primary');
  });

  it('treats an elapsed rate limit as spent', () => {
    expect(quotaEntries({ daily: { observed_at: PAST, ratelimited_until: PAST } }, NOW)[0].rateLimitedUntil).toBeNull();
    expect(quotaEntries({ daily: { observed_at: PAST, ratelimited_until: FUTURE } }, NOW)[0].rateLimitedUntil).toBe(FUTURE);
  });

  it('drops a window the snapshot reports no percentage for', () => {
    expect(quotaEntries({ daily: { observed_at: PAST, primary_reset_after_at: FUTURE } }, NOW)[0].windows).toEqual([]);
  });
});

describe('codex credits', () => {
  it('takes the freshest observation that carries a balance', () => {
    const credits = latestCredits({
      stale: { observed_at: '2026-07-01T00:00:00.000Z', credits_balance: 10 },
      fresh: { observed_at: '2026-07-20T00:00:00.000Z', credits_balance: 3 },
      silent: { observed_at: '2026-07-27T00:00:00.000Z' },
    });
    expect(credits?.credits_balance).toBe(3);
  });

  it('is null when no snapshot mentions credits at all', () => {
    expect(latestCredits({ daily: { observed_at: PAST, primary_used_percent: 1 } })).toBeNull();
    expect(latestCredits(null)).toBeNull();
  });
});

describe('codex reset cards', () => {
  const credit = (overrides: Partial<CodexRateLimitResetCredit> = {}): CodexRateLimitResetCredit => ({
    id: 'credit-1', reset_type: 'codex_rate_limits', status: 'available',
    granted_at: PAST, expires_at: FUTURE, title: null, description: null, ...overrides,
  });

  it('only enables known available, unexpired Codex reset cards', () => {
    expect(codexResetCreditIsUsable(credit(), NOW)).toBe(true);
    expect(codexResetCreditIsUsable(credit({ status: 'redeemed' }), NOW)).toBe(false);
    expect(codexResetCreditIsUsable(credit({ reset_type: 'future_reset' }), NOW)).toBe(false);
    expect(codexResetCreditIsUsable(credit({ expires_at: PAST }), NOW)).toBe(false);
    expect(codexResetCreditIsUsable(credit({ expires_at: null }), NOW)).toBe(true);
  });
});

describe('codex account status', () => {
  it('reports the furthest live rate limit', () => {
    const entries = quotaEntries({
      daily: { observed_at: PAST, ratelimited_until: FUTURE },
      weekly: { observed_at: PAST, ratelimited_until: '2026-07-28T18:00:00.000Z' },
    }, NOW);
    expect(accountStatus(activeLookup, entries)).toEqual({ tone: 'danger', reason: 'rate-limited', until: '2026-07-28T18:00:00.000Z' });
  });

  it('puts a broken credential ahead of any quota reading', () => {
    const credential = { chatgptAccountId: ACCOUNT_ID, state: 'session_terminated' as const, state_message: 'revoked', state_updated_at: PAST };
    const entries = quotaEntries({ daily: { observed_at: PAST, ratelimited_until: FUTURE } }, NOW);
    expect(accountStatus({ kind: 'present', credential }, entries)).toEqual({ tone: 'danger', reason: 'session-terminated', detail: 'revoked' });
  });

  it('warns on heavy usage across any window', () => {
    const entries = quotaEntries({ daily: { observed_at: PAST, primary_used_percent: 12, secondary_used_percent: 84 } }, NOW);
    expect(accountStatus(activeLookup, entries)).toEqual({ tone: 'warning', reason: 'heavy', percent: 84 });
  });

  it('stays active with no snapshots at all', () => {
    expect(accountStatus(activeLookup, [])).toEqual({ tone: 'success', reason: 'active' });
  });

  it('marks a config/state account mismatch as dangerous', () => {
    expect(accountStatus({ kind: 'account-id-mismatch', expectedAccountId: ACCOUNT_ID }, []))
      .toEqual({ tone: 'danger', reason: 'account-id-mismatch' });
  });
});
