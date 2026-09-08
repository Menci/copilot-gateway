import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  consumeCodexRateLimitResetCredit,
  fetchCodexRateLimitResetCredits,
  parseCodexRateLimitResetCredits,
} from '../src/rate-limit-resets.ts';
import { readJsonRequest, testFetcher } from '@floway-dev/test-utils';

const detail = {
  id: 'credit-1',
  reset_type: 'codex_rate_limits',
  status: 'available',
  granted_at: '2026-06-17T00:00:00Z',
  expires_at: '2026-07-17T00:00:00Z',
  title: 'Full reset (Weekly + 5 hr)',
  description: 'Ready to redeem',
};

afterEach(() => vi.restoreAllMocks());

describe('Codex rate-limit reset cards', () => {
  test('lists cards with the official ChatGPT account headers and preserves future open strings', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      credits: [{ ...detail, reset_type: 'future_reset_type', status: 'future_status', ignored: true }],
      available_count: 2,
      total_earned_count: 4,
    }));

    const result = await fetchCodexRateLimitResetCredits({
      accessToken: 'at_test', accountId: 'acc_test', fetcher: testFetcher,
    });

    expect(result).toEqual({
      available_count: 2,
      credits: [{ ...detail, reset_type: 'future_reset_type', status: 'future_status' }],
    });
    const [url, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
    expect(headers.get('authorization')).toBe('Bearer at_test');
    expect(headers.get('chatgpt-account-id')).toBe('acc_test');
  });

  test('consumes the selected card with a caller-stable idempotency key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      code: 'already_redeemed', credit: { id: 'ignored' }, windows_reset: 2,
    }));

    const result = await consumeCodexRateLimitResetCredit({
      accessToken: 'at_test', accountId: 'acc_test', creditId: 'credit-1',
      idempotencyKey: 'redeem-123', fetcher: testFetcher,
    });

    expect(result).toEqual({ code: 'already_redeemed' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
    expect(init?.method).toBe('POST');
    expect(await readJsonRequest(init ?? {})).toEqual({
      redeem_request_id: 'redeem-123', credit_id: 'credit-1',
    });
  });

  test('fails loudly on malformed card details', () => {
    expect(() => parseCodexRateLimitResetCredits({ available_count: 1, credits: [{ ...detail, id: '' }] }))
      .toThrow(/credits\[0\]\.id/);
    expect(() => parseCodexRateLimitResetCredits({ available_count: 1, credits: [{ ...detail, expires_at: 'tomorrow-ish' }] }))
      .toThrow(/credits\[0\]\.expires_at/);
  });

  test('retains upstream status and body on a failed list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('slow down', { status: 429 }));
    const promise = fetchCodexRateLimitResetCredits({
      accessToken: 'at_test', accountId: 'acc_test', fetcher: testFetcher,
    });
    await expect(promise).rejects.toMatchObject({
      status: 429, responseBody: 'slow down', operation: 'list',
    });
  });
});
