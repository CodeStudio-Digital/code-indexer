/**
 * Completion-quality block (Telemetry → Completion): the instrument that
 * tells whether the ghost-text overhaul is working — real accept rate
 * (accepted/shown), latency percentiles, outcome/endpoint splits, per-model
 * comparison (FIM vs chat fallback) and daily trend. Data comes from the
 * same editor.stats handler the StatusBar chip uses.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { apiCall } from '../../lib/api-client.js';
import type { EditorStatsResult } from '@mcp/api-bus';
import { cn } from '../../lib/utils.js';

function StatCard({ label, value, intent }: { label: string; value: string; intent?: 'good' | 'warn' }) {
  const valueClass = intent === 'good'
    ? 'text-emerald-600 dark:text-emerald-400'
    : intent === 'warn'
      ? 'text-amber-600 dark:text-amber-400'
      : '';
  return (
    <div className="rounded-md border p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-lg font-semibold tabular-nums', valueClass)}>{value}</div>
    </div>
  );
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function ms(v: number | null): string {
  return v === null ? '—' : `${v}ms`;
}

export function CompletionQualityPanel() {
  const { t } = useTranslation(['telemetry']);
  const [days, setDays] = useState(7);
  const [data, setData] = useState<EditorStatsResult | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (d: number) => {
    setLoading(true);
    void apiCall<EditorStatsResult>('editor.stats', { days: d })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(days); }, [days]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('telemetry:completion.subtitle')}</p>
        <div className="flex shrink-0 items-center gap-1">
          {[7, 30].map((d) => (
            <Button
              key={d} variant={days === d ? 'secondary' : 'ghost'} size="sm"
              className="h-6 px-2 text-xs" onClick={() => setDays(d)}
            >
              {t(`telemetry:completion.window.${d}`)}
            </Button>
          ))}
          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => load(days)}>
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {data && !data.configured && (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {t('telemetry:completion.unconfigured')}
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={t('telemetry:completion.requests')} value={String(data.requests)} />
            <StatCard label={t('telemetry:completion.shown')} value={String(data.shown)} />
            <StatCard
              label={t('telemetry:completion.acceptRate')}
              value={pct(data.acceptRate)}
              intent={data.acceptRate === null ? undefined : data.acceptRate >= 0.25 ? 'good' : data.acceptRate < 0.1 ? 'warn' : undefined}
            />
            <StatCard label={t('telemetry:completion.accepted')} value={String(data.accepted)} />
            <StatCard label={t('telemetry:completion.p50')} value={ms(data.latency.p50)} />
            <StatCard
              label={t('telemetry:completion.p90')}
              value={ms(data.latency.p90)}
              intent={data.latency.p90 !== null && data.latency.p90 > 1500 ? 'warn' : data.latency.p90 !== null && data.latency.p90 <= 800 ? 'good' : undefined}
            />
            <StatCard label={t('telemetry:completion.rejected')} value={String(data.rejected)} />
            <StatCard label={t('telemetry:completion.partial')} value={String(data.partial)} />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-md border p-3">
              <div className="mb-2 text-xs font-medium">{t('telemetry:completion.status.title')}</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(data.statusBreakdown).sort((a, b) => b[1] - a[1]).map(([status, n]) => (
                  <span
                    key={status}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[11px] tabular-nums',
                      status === 'ok' ? 'bg-emerald-500/10 text-emerald-500'
                        : status === 'timeout' || status === 'provider_error' ? 'bg-amber-500/10 text-amber-500'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {status} · {n}
                  </span>
                ))}
              </div>
              <div className="mb-2 mt-3 text-xs font-medium">{t('telemetry:completion.endpoint.title')}</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(data.endpointSplit).sort((a, b) => b[1] - a[1]).map(([ep, n]) => (
                  <span key={ep} className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                    {ep} · {n}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-md border p-3">
              <div className="mb-2 text-xs font-medium">{t('telemetry:completion.byModel.title')}</div>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 font-normal">{t('telemetry:completion.byModel.model')}</th>
                    <th className="py-1 text-right font-normal">{t('telemetry:completion.byModel.requests')}</th>
                    <th className="py-1 text-right font-normal">{t('telemetry:completion.byModel.shown')}</th>
                    <th className="py-1 text-right font-normal">{t('telemetry:completion.byModel.accepted')}</th>
                    <th className="py-1 text-right font-normal">{t('telemetry:completion.byModel.rate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((m) => (
                    <tr key={m.model} className="border-t border-border/40">
                      <td className="max-w-[160px] truncate py-1" title={m.model}>{m.model}</td>
                      <td className="py-1 text-right tabular-nums">{m.requests}</td>
                      <td className="py-1 text-right tabular-nums">{m.shown}</td>
                      <td className="py-1 text-right tabular-nums">{m.accepted}</td>
                      <td className="py-1 text-right tabular-nums">{m.shown > 0 ? pct(m.accepted / m.shown) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-md border p-3">
            <div className="mb-2 text-xs font-medium">{t('telemetry:completion.daily.title')}</div>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1 font-normal">{t('telemetry:completion.daily.day')}</th>
                  <th className="py-1 text-right font-normal">{t('telemetry:completion.requests')}</th>
                  <th className="py-1 text-right font-normal">{t('telemetry:completion.shown')}</th>
                  <th className="py-1 text-right font-normal">{t('telemetry:completion.accepted')}</th>
                  <th className="py-1 text-right font-normal">{t('telemetry:completion.acceptRate')}</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((d) => (
                  <tr key={d.day} className="border-t border-border/40">
                    <td className="py-1 tabular-nums">{d.day}</td>
                    <td className="py-1 text-right tabular-nums">{d.requests}</td>
                    <td className="py-1 text-right tabular-nums">{d.shown}</td>
                    <td className="py-1 text-right tabular-nums">{d.accepted}</td>
                    <td className="py-1 text-right tabular-nums">{d.shown > 0 ? pct(d.accepted / d.shown) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
