import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CopilotQuotaReport } from '@mcp/api-bus';
import { Button } from '../../../components/ui/button.js';
import { Progress } from '../../../components/ui/progress.js';

type LoadState = 'idle' | 'loading' | 'ready' | 'reconnect' | 'error';

export function CopilotQuotaPanel({ providerId, linked }: { providerId: string; linked: boolean }) {
  const { t, i18n } = useTranslation('admin');
  const [report, setReport] = useState<CopilotQuotaReport | null>(null);
  const [state, setState] = useState<LoadState>('idle');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function load() {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setState('loading');
    try {
      const result = await fetch('/api/admin/providers/' + encodeURIComponent(providerId) + '/copilot-quota', {
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
  }

  const locale = i18n.resolvedLanguage;
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });

  return (
    <section className="mb-3 rounded-md border border-border px-3 py-2.5 text-xs" aria-labelledby="copilot-quota-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="copilot-quota-heading" className="font-semibold">{t('copilot.quota.heading')}</h3>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2"
            title={t('copilot.quota.openGitHub')}
            onClick={() => window.electronAPI?.openExternal?.('https://github.com/settings/copilot')}>
            <ExternalLink className="h-3.5 w-3.5" />
            {t('copilot.quota.openGitHub')}
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2"
            disabled={!linked || state === 'loading'} onClick={() => void load()}>
            <RefreshCw className={state === 'loading' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            {report ? t('copilot.quota.refresh') : t('copilot.quota.check')}
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
