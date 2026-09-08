import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, callApi } from '../../api/client';
import type { CodexRateLimitResetCredit, CodexRateLimitResetCredits } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { StatusBadge } from '../ui/status-badge';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { useRefresh } from '../ui/use-refresh';
import { codexResetCreditIsUsable, type CodexRecord } from '../upstreams/codex-account';
import { WALL_CLOCK_REFRESH_MS } from '../upstreams/subscription-quota';

const { Button, Text } = fluentComponents;

interface RedeemInvocation {
  credit: CodexRateLimitResetCredit;
  idempotencyKey: string;
}

const outcomeKey = (code: string): 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit' | 'unknown' => {
  if (code === 'reset') return 'reset';
  if (code === 'already_redeemed') return 'alreadyRedeemed';
  if (code === 'nothing_to_reset') return 'nothingToReset';
  if (code === 'no_credit') return 'noCredit';
  return 'unknown';
};

const statusKey = (status: string): 'available' | 'expired' | 'redeemed' | null => {
  if (status === 'available' || status === 'expired' || status === 'redeemed') return status;
  return null;
};

export function CodexResetCards({ onQuotaReset, record }: {
  onQuotaReset: () => void;
  record: CodexRecord;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const [cards, setCards] = useState<CodexRateLimitResetCredits | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ code: string; warning: string | null } | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const dialog = useDialogInvocation<RedeemInvocation>();
  const envelope = useMemo(() => ({
    id: record.id,
    kind: 'codex' as const,
    config: record.config,
    state: record.state,
    proxy_fallback_list: record.proxy_fallback_list,
  }), [record.config, record.id, record.proxy_fallback_list, record.state]);

  const { refresh: load, refreshing: loading } = useRefresh(useCallback(async (signal: AbortSignal) => {
    setLoadError(null);
    const { data, error } = await callApi(() => api.api.upstreams.codex['reset-credits'].$post(
      { json: { record: envelope } },
      { init: { signal } },
    ));
    if (signal.aborted) return;
    if (error) {
      setLoadError(error.message);
      return;
    }
    setCards(data.reset_credits);
  }, [envelope]));

  useEffect(() => {
    if (record.id !== '') void load();
  }, [load, record.id]);

  const redeem = async () => {
    const invocation = dialog.invocation?.value;
    if (!invocation) return;
    setRedeeming(true);
    setRedeemError(null);
    try {
      const { data, error } = await callApi(() => api.api.upstreams.codex['reset-credits'].consume.$post({
        json: {
          record: envelope,
          credit_id: invocation.credit.id,
          idempotency_key: invocation.idempotencyKey,
        },
      }));
      if (error) {
        setRedeemError(error.message);
        return;
      }
      if (data.reset_credits !== null) {
        setCards(data.reset_credits);
      } else if (data.outcome.code === 'reset' || data.outcome.code === 'already_redeemed' || data.outcome.code === 'no_credit') {
        setCards(current => {
          if (current === null) return null;
          const removed = current.credits.some(credit => credit.id === invocation.credit.id);
          return {
            available_count: Math.max(0, current.available_count - (removed ? 1 : 0)),
            credits: current.credits.filter(credit => credit.id !== invocation.credit.id),
          };
        });
      }
      if (data.outcome.code === 'reset' || data.outcome.code === 'already_redeemed') onQuotaReset();
      setOutcome({ code: data.outcome.code, warning: data.refresh_error });
      dialog.close();
    } finally {
      setRedeeming(false);
    }
  };

  const selected = dialog.invocation?.value.credit;
  const resultKey = outcome === null ? null : outcomeKey(outcome.code);

  return <section className="grid gap-3 border-0 border-t border-solid border-fui-divider pt-4">
    <SectionHeader
      level={3}
      title={t('dashboard.upstreamEditor.codex.resetCards.title')}
      description={cards === null ? undefined : t('dashboard.upstreamEditor.codex.resetCards.available', { count: cards.available_count })}
      actions={<ResourceListActions
        appearance="subtle"
        disabled={record.id === ''}
        onRefresh={() => void load()}
        refreshLabel={t('dashboard.upstreamEditor.codex.resetCards.refresh')}
        refreshing={loading}
      />}
    />

    {cards?.credits.map(credit => {
      const usable = codexResetCreditIsUsable(credit, now);
      const knownStatus = statusKey(credit.status);
      return <article className="grid gap-2 rounded-md border border-solid border-fui-divider p-3" key={credit.id}>
        <div className="flex items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <Text weight="semibold">{credit.title ?? t('dashboard.upstreamEditor.codex.resetCards.defaultTitle')}</Text>
            {credit.description && <Text size={200} className="text-fui-fg2">{credit.description}</Text>}
          </div>
          <StatusBadge tone={usable ? 'success' : 'neutral'}>{knownStatus === null
            ? credit.status
            : t(`dashboard.upstreamEditor.codex.resetCards.status.${knownStatus}`)}</StatusBadge>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.codex.resetCards.granted', { time: dateTime(credit.granted_at, locale) })}</Text>
          <Text size={200} className="text-fui-fg3">{credit.expires_at === null
            ? t('dashboard.upstreamEditor.codex.resetCards.noExpiry')
            : t('dashboard.upstreamEditor.codex.resetCards.expires', { time: dateTime(credit.expires_at, locale) })}</Text>
        </div>
        <div className="flex justify-end">
          {usable && <Button appearance="primary" onClick={() => dialog.open({ credit, idempotencyKey: crypto.randomUUID() })}>
            {t('dashboard.upstreamEditor.codex.resetCards.use')}
          </Button>}
        </div>
      </article>;
    })}

    {cards !== null && cards.credits.length === 0 && !loading && <Text size={200} className="text-fui-fg3">
      {t('dashboard.upstreamEditor.codex.resetCards.empty')}
    </Text>}
    {loadError && <OutcomeMessageBar onDismiss={() => setLoadError(null)}>{loadError}</OutcomeMessageBar>}
    {outcome && resultKey && <OutcomeMessageBar
      intent={resultKey === 'reset' || resultKey === 'alreadyRedeemed' ? 'success' : 'info'}
      onDismiss={() => setOutcome(null)}
    >
      <span>{resultKey === 'unknown'
        ? t('dashboard.upstreamEditor.codex.resetCards.result.unknown', { code: outcome.code })
        : t(`dashboard.upstreamEditor.codex.resetCards.result.${resultKey}`)}</span>
      {outcome.warning && <span>{t('dashboard.upstreamEditor.codex.resetCards.refreshWarning', { error: outcome.warning })}</span>}
    </OutcomeMessageBar>}

    {dialog.invocation && selected && <ConfirmDialog
      key={dialog.invocation.key}
      actionIntent="primary"
      actionLabel={t('dashboard.upstreamEditor.codex.resetCards.use')}
      busy={redeeming}
      error={redeemError}
      message={t('dashboard.upstreamEditor.codex.resetCards.confirmMessage', { title: selected.title ?? t('dashboard.upstreamEditor.codex.resetCards.defaultTitle') })}
      onConfirm={() => void redeem()}
      onDismissError={() => setRedeemError(null)}
      onExited={() => setRedeemError(null)}
      onOpenChange={open => { if (!open) dialog.close(); }}
      open={dialog.isOpen}
      title={t('dashboard.upstreamEditor.codex.resetCards.confirmTitle')}
    />}
  </section>;
}
