import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexAccountCard } from '../../../src/components/upstream-editor/codex-account-card';
import { CodexResetCards } from '../../../src/components/upstream-editor/codex-reset-cards';
import type { CodexRecord } from '../../../src/components/upstreams/codex-account';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';

stubLocalStorage();

const card = {
  id: 'credit-1',
  reset_type: 'codex_rate_limits',
  status: 'available',
  granted_at: '2026-06-17T00:00:00Z',
  expires_at: null,
  title: 'Full reset',
  description: 'Ready to redeem',
};

const record = upstreamRecord('up_codex', {
  kind: 'codex',
  config: { accounts: [{ email: 'alice@example.com', chatgptAccountId: 'acc_test', chatgptUserId: 'usr_test', planType: 'plus' }] },
  state: { accounts: [{ chatgptAccountId: 'acc_test', state: 'active', state_updated_at: '2026-06-17T00:00:00Z' }] },
}) as CodexRecord;

let consumeBodies: Array<{ idempotency_key: string }>;
let consumeAttempts: number;
let failFirstConsume: boolean;

beforeEach(() => {
  consumeAttempts = 0;
  consumeBodies = [];
  failFirstConsume = true;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/upstreams/codex/reset-credits') {
      return Response.json({ reset_credits: { available_count: 1, credits: [card] } });
    }
    if (path === '/api/upstreams/codex/reset-credits/consume') {
      consumeAttempts += 1;
      consumeBodies.push(JSON.parse(String(init?.body)) as { idempotency_key: string });
      if (failFirstConsume && consumeAttempts === 1) return Response.json({ error: 'temporary failure' }, { status: 502 });
      return Response.json({
        outcome: { code: 'reset' },
        reset_credits: null,
        refresh_error: 'list refresh failed',
      });
    }
    throw new Error(`Unexpected request to ${path}`);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Codex reset cards', () => {
  it('loads, confirms, and reuses one redemption key when a retry succeeds', async () => {
    const onQuotaReset = vi.fn();
    renderInApp(<CodexResetCards record={record} onQuotaReset={onQuotaReset} />);

    expect(await screen.findByText('Full reset')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use reset card' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Use reset card' });

    fireEvent.click(confirm);
    expect(await within(dialog).findByText('temporary failure')).toBeTruthy();
    fireEvent.click(confirm);

    await waitFor(() => expect(onQuotaReset).toHaveBeenCalledOnce());
    expect(consumeBodies).toHaveLength(2);
    expect(consumeBodies.map(body => body.idempotency_key)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(await screen.findByText('The Codex rate-limit windows were reset.')).toBeTruthy();
    expect(screen.queryByText('Full reset')).toBeNull();
    expect(screen.getByText(/list refresh failed/)).toBeTruthy();
  });

  it('removes both the quota windows and account credit summary after a reset', async () => {
    failFirstConsume = false;
    const accountRecord: CodexRecord = {
      ...record,
      codex_quota: {
        codex: {
          observed_at: '2026-06-17T00:00:00Z',
          primary_used_percent: 100,
          credits_has_credits: true,
          credits_balance: 1,
        },
      },
    };
    renderInApp(<CodexAccountCard record={accountRecord} />);

    expect(screen.getByText('credits: 1')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Use reset card' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use reset card' }));

    await waitFor(() => expect(screen.queryByText('credits: 1')).toBeNull());
    expect(screen.getByText('No quota snapshots yet - Codex calls populate them.')).toBeTruthy();
  });
});
