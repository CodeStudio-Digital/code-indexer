import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CopilotQuotaReport } from '@mcp/api-bus';
import { Button } from '../../../components/ui/button.js';
import { Progress } from '../../../components/ui/progress.js';
import { fetchProviders } from '../api.js';

type LoadState = 'idle' | 'loading' | 'ready' | 'reconnect' | 'error';
type QuotaPanelProps = { variant?: 'settings'; providerId: string; linked: boolean }
  | { variant: 'quick'; providerId?: string };

async function findCopilotProvider(preferredId: string | undefined, signal: AbortSignal) {
  const connected = (await fetchProviders(signal)).filter(provider =>
    provider.kind === 'copilot' && (provider.enabled || typeof provider.extra.githubLogin === 'string'));
  return (connected.find(provider => provider.id === preferredId)
    ?? connected.find(provider => provider.is_default)
    ?? connected.find(provider => provider.id === 'copilot')
    ?? connected[0])?.id;
}

export function CopilotQuotaPanel(props: QuotaPanelProps) {
  const { t, i18n } = useTranslation('admin');
  const { providerId } = props;
  const quick = props.variant === 'quick';
  const linked = props.variant === 'quick' || props.linked;
  const headingId = useId();
  const [report, setReport] = useState<CopilotQuotaReport | null>(null);
  const [state, setState] = useState<LoadState>(quick ? 'loading' : 'idle');
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setState('loading');
    try {
      const id = quick ? await findCopilotProvider(providerId, controller.signal) : providerId;
      if (controller.signal.aborted) return;
      if (!id) {
        setReport(null);
        setState('reconnect');
        return;
      }
      const result = await fetch('/api/admin/providers/' + encodeURIComponent(id) + '/copilot-quota', {
        signal: controller.signal, cache: 'no-store',
      });
      if (controller.signal.aborted) return;
      if (result.status === 409) {
        setReport(null);
        setState('reconnect');
        return;
      }
      if (!result.ok) throw new Error('Copilot quota unavailable');
      const quota = await result.json() as CopilotQuotaReport;
      if (!controller.signal.aborted) {
        setReport(quota);
        setState('ready');
      }
    } catch {
      if (!controller.signal.aborted) setState('error');
    }
  }, [providerId, quick]);

  useEffect(() => {
    if (quick) void load();
    return () => request.current?.abort();
  }, [load, quick]);

  const locale = i18n.resolvedLanguage;
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
  const refreshLabel = t(quick || report ? 'copilot.quota.refresh' : 'copilot.quota.check');

  return (
    <section className={quick ? 'p-3 text-xs' : 'mb-3 rounded-md border border-border px-3 py-2.5 text-xs'} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="font-semibold">{quick ? 'GitHub Copilot' : t('copilot.quota.heading')}</h3>
        <div className="flex items-center gap-2">
          {!quick && <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2"
            title={t('copilot.quota.openGitHub')}
            onClick={() => window.electronAPI?.openExternal?.('https://github.com/settings/copilot')}>
            <ExternalLink className="h-3.5 w-3.5" />
            {t('copilot.quota.openGitHub')}
          </Button>}
          <Button type="button" size="sm" variant={quick ? 'ghost' : 'outline'}
            className={quick ? 'h-7 w-7 p-0' : 'h-7 gap-1.5 px-2'} title={refreshLabel} aria-label={refreshLabel}
            disabled={!linked || state === 'loading'} onClick={() => void load()}>
            <RefreshCw className={state === 'loading' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            {!quick && refreshLabel}
          </Button>
        </div>
      </div>

      {(!linked || state === 'reconnect') && <p className="mt-2 text-muted-foreground">{t('copilot.quota.connect')}</p>}
      {state === 'loading' && <p role="status" className="mt-2 text-muted-foreground">{t('copilot.quota.loading')}</p>}
      {state === 'error' && <p role="status" className="mt-2 text-destructive">{t('copilot.quota.error')}</p>}
      {report?.quotas.length === 0 && <p role="status" className="mt-2 text-muted-foreground">{t('copilot.quota.unavailable')}</p>}

      {report?.quotas.map(quota => (
        <div key={quota.category} className="mt-2.5 space-y-2 border-t border-border/60 pt-2.5">
          <p className="font-medium">
            {quota.unit === 'credits' && quota.category === 'premium_interactions'
              ? t('copilot.quota.credits') : t('copilot.quota.category.' + quota.category)}
            {quota.unit === 'credits' && quota.category !== 'premium_interactions' && ' · ' + t('copilot.quota.credits')}
          </p>
          <dl className="flex flex-wrap gap-x-5 gap-y-2">
            {quota.used !== null && (
              <div><dt className="text-muted-foreground">{t('copilot.quota.used')}</dt><dd className="tabular-nums">{numbers.format(quota.used)}</dd></div>
            )}
            {quota.limit !== null && (
              <div><dt className="text-muted-foreground">{t('copilot.quota.limit')}</dt><dd className="tabular-nums">{numbers.format(quota.limit)}</dd></div>
            )}
            {quota.remaining !== null && (
              <div><dt className="text-muted-foreground">{t('copilot.quota.remaining')}</dt><dd className="font-semibold tabular-nums">{numbers.format(quota.remaining)}</dd></div>
            )}
          </dl>
          {quota.remainingPercent !== null && (
            <div className="flex items-center gap-2">
              <Progress className="h-1.5 flex-1" value={quota.remainingPercent} aria-label={t('copilot.quota.remaining')} />
              <span className="tabular-nums text-muted-foreground">{t('copilot.quota.percent', { value: numbers.format(quota.remainingPercent) })}</span>
            </div>
          )}
          {quota.limit === null && quota.remaining === null && <p className="text-muted-foreground">{t('copilot.quota.unavailable')}</p>}
          {quota.resetAt && <p className="text-muted-foreground">{t('copilot.quota.resets', { date: dateTime.format(new Date(quota.resetAt)) })}</p>}
        </div>
      ))}
      {report && <p className="mt-2 text-muted-foreground">{t('copilot.quota.checked', { time: time.format(new Date(report.checkedAt)) })}</p>}
    </section>
  );
}
