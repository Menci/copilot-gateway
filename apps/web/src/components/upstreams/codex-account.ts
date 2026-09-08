// Codex groups primary/secondary windows by limit id while credits come from
// account-wide headers:
// https://github.com/openai/codex/blob/f2bee854a73666e1c3e922a853dda591b1a25fcf/codex-rs/codex-api/src/rate_limits.rs#L27-L100
// https://github.com/openai/codex/blob/f2bee854a73666e1c3e922a853dda591b1a25fcf/codex-rs/codex-api/src/rate_limits.rs#L217-L228

import { HEAVY_USAGE_THRESHOLD_PERCENT, heaviestPercent } from './subscription-quota';
import type {
  CodexAccountCredentialState,
  CodexQuotaSnapshot,
  CodexQuotaSnapshotMap,
  CodexRateLimitResetCredit,
  UpstreamRecord,
} from '../../api/types';

export type CodexRecord = Extract<UpstreamRecord, { kind: 'codex' }>;

export const codexResetCreditIsUsable = (credit: CodexRateLimitResetCredit, now: number): boolean =>
  credit.reset_type === 'codex_rate_limits'
  && credit.status === 'available'
  && (credit.expires_at === null || new Date(credit.expires_at).getTime() > now);

// `chatgpt_plan_type` is an untagged `Known | Unknown(String)` upstream, so the
// raw value is preserved and a plan this table does not know is forwarded as it
// arrived rather than dropped.
// https://github.com/openai/codex/blob/936f5eb3ee223ab34dcb221fa7c5f9943c8092bd/codex-rs/protocol/src/auth.rs#L60
//
// Two entries read as contradictions and are not: OpenAI renamed ChatGPT Team
// to ChatGPT Business without changing the wire identifier, and groups the
// `business` identifier with its enterprise plans. Codex's own status line maps
// them exactly this way, under a table test.
// https://github.com/openai/codex/blob/936f5eb3ee223ab34dcb221fa7c5f9943c8092bd/codex-rs/tui/src/status/helpers.rs#L99
// https://help.openai.com/en/articles/12111915-chatgpt-team-is-now-chatgpt-business
const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Business',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  business: 'Enterprise',
  ent26: 'Enterprise',
  enterprise: 'Enterprise',
  hc: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise (Automation)',
  enterprise_cbp_usage_based: 'Enterprise',
  edu: 'Edu',
  education: 'Edu',
};

export const planLabel = (account: CodexRecord['config']['accounts'][number]): string | null =>
  account.planType ? `ChatGPT ${PLAN_NAMES[account.planType] ?? account.planType}` : null;

export interface QuotaWindow {
  key: 'primary' | 'secondary';
  percent: number;
  resetAt: string | null;
  windowMinutes: number | null;
}

export interface QuotaEntry {
  key: string;
  label: string;
  observedAt: string;
  rateLimitedUntil: string | null;
  windows: QuotaWindow[];
}

export type CredentialLookup =
  | { kind: 'present'; credential: CodexAccountCredentialState }
  | { kind: 'account-id-mismatch'; expectedAccountId: string };

export const findCredential = (record: CodexRecord): CredentialLookup => {
  const expectedAccountId = record.config.accounts[0].chatgptAccountId;
  const credential = record.state.accounts.find(account => account.chatgptAccountId === expectedAccountId);
  return credential ? { kind: 'present', credential } : { kind: 'account-id-mismatch', expectedAccountId };
};

const window = (
  key: QuotaWindow['key'],
  percent: number | undefined,
  resetAt: string | undefined,
  windowMinutes: number | undefined,
): QuotaWindow | null => typeof percent === 'number' && Number.isFinite(percent)
  ? { key, percent, resetAt: resetAt ?? null, windowMinutes: windowMinutes ?? null }
  : null;

const stillRateLimited = (until: string | undefined, now: number): string | null =>
  typeof until === 'string' && new Date(until).getTime() > now ? until : null;

export const quotaEntries = (quota: CodexQuotaSnapshotMap | null | undefined, now: number): QuotaEntry[] =>
  Object.entries(quota ?? {})
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, snapshot]) => ({
      key,
      label: snapshot.active_limit ?? key,
      observedAt: snapshot.observed_at,
      rateLimitedUntil: stillRateLimited(snapshot.ratelimited_until, now),
      windows: [
        window('primary', snapshot.primary_used_percent, snapshot.primary_reset_after_at, snapshot.primary_window_minutes),
        window('secondary', snapshot.secondary_used_percent, snapshot.secondary_reset_after_at, snapshot.secondary_window_minutes),
      ].filter((entry): entry is QuotaWindow => entry !== null),
    }));

// Only one limit is active at a time, so a compact readout states the entry
// that was observed last rather than every key the map has accumulated.
export const latestQuotaEntry = (entries: QuotaEntry[]): QuotaEntry | null =>
  entries.toSorted((left, right) => new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime())[0] ?? null;

export const latestCredits = (quota: CodexQuotaSnapshotMap | null | undefined): CodexQuotaSnapshot | null => {
  let newest: CodexQuotaSnapshot | null = null;
  let newestObservedAt = Number.NEGATIVE_INFINITY;
  for (const snapshot of Object.values(quota ?? {})) {
    if (snapshot.credits_balance === undefined && snapshot.credits_has_credits === undefined) continue;
    const observedAt = new Date(snapshot.observed_at).getTime();
    if (observedAt > newestObservedAt) {
      newest = snapshot;
      newestObservedAt = observedAt;
    }
  }
  return newest;
};

export type AccountStatus =
  | { tone: 'danger'; reason: 'account-id-mismatch' | 'session-terminated' | 'refresh-failed'; detail?: string }
  | { tone: 'danger'; reason: 'rate-limited'; until: string; detail?: string }
  | { tone: 'warning'; reason: 'heavy'; percent: number }
  | { tone: 'success'; reason: 'active' };

export const accountStatus = (lookup: CredentialLookup, entries: QuotaEntry[]): AccountStatus => {
  if (lookup.kind === 'account-id-mismatch') return { tone: 'danger', reason: 'account-id-mismatch' };
  const { credential } = lookup;
  if (credential.state === 'session_terminated') return { tone: 'danger', reason: 'session-terminated', detail: credential.state_message };
  if (credential.state === 'refresh_failed') return { tone: 'danger', reason: 'refresh-failed', detail: credential.state_message };
  const until = entries
    .map(entry => entry.rateLimitedUntil)
    .filter((value): value is string => value !== null)
    .toSorted((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];
  if (until !== undefined) return { tone: 'danger', reason: 'rate-limited', until };
  const heaviest = heaviestPercent(entries.flatMap(entry => entry.windows.map(item => item.percent)));
  if (heaviest !== null && heaviest >= HEAVY_USAGE_THRESHOLD_PERCENT) return { tone: 'warning', reason: 'heavy', percent: Math.round(heaviest) };
  return { tone: 'success', reason: 'active' };
};
