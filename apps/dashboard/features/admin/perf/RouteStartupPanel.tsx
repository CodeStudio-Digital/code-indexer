import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import {
  acquireRouteMetricsCollection,
  getRouteStartupSnapshot,
  resetRouteStartupMetrics,
  startProjectRoute,
  type RouteMetricVital,
  type RouteStartupSample,
  type RouteStartupSnapshot,
} from '../../../lib/perf/route-startup-metrics.js';

type TimelineRow = {
  id: string;
  kind: 'event' | 'span' | 'vital';
  name: string;
  atMs: number;
  durationMs?: number;
  status?: string;
  detail?: string;
};

export function RouteStartupPanel() {
  const { t } = useTranslation('admin');
  const [snapshot, setSnapshot] = useState<RouteStartupSnapshot>(() => getRouteStartupSnapshot());

  useEffect(() => {
    const release = acquireRouteMetricsCollection();
    const refresh = () => setSnapshot(getRouteStartupSnapshot());
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => {
      clearInterval(timer);
      release();
    };
  }, []);

  const current = snapshot.current;
  const rows = useMemo(() => buildTimeline(current), [current]);
  const topSpans = useMemo(
    () => [...(current?.spans ?? [])].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    [current?.spans],
  );
  const emptyPaint = current?.events.find((event) => event.name === 'EmptyChatState:painted');
  const longTasks = current?.vitals.filter((vital) => vital.name === 'longtask') ?? [];
  const fullGitWhileChat = current?.spans.filter(
    (span) => span.name === 'projectGit.status(full)' && span.tab === 'chat',
  ) ?? [];
  const maxLongTask = longTasks.reduce<RouteMetricVital | undefined>(
    (best, row) => (!best || (row.durationMs ?? 0) > (best.durationMs ?? 0) ? row : best),
    undefined,
  );

  const handleReset = () => {
    resetRouteStartupMetrics();
    // Hash-routed app (createHashRouter): the route lives after the `#`, so the
    // raw pathname is just the index.html path and never matches.
    const match = window.location.hash.replace(/^#/, '').match(/^\/projects\/(\d+)/);
    if (match) {
      startProjectRoute(Number(match[1]), { source: 'manual-reset' });
    }
    setSnapshot(getRouteStartupSnapshot());
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `route-startup-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{t('perf.route.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('perf.route.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={handleReset}>
            {t('perf.route.reset')}
          </Button>
          <Button size="sm" variant="outline" onClick={handleExport} disabled={!current}>
            {t('perf.route.exportJson')}
          </Button>
        </div>
      </div>

      {!current ? (
        <div className="border rounded-md p-3 text-xs text-muted-foreground">{t('perf.route.empty')}</div>
      ) : (
        <>
          <div className="grid gap-2 md:grid-cols-5">
            <Metric label={t('perf.route.project')} value={current.projectId ? `#${current.projectId}` : '-'} />
            <Metric label="FCP" value={formatMs(current.fcpMs)} />
            <Metric label="LCP" value={formatMs(current.lcp?.atMs)} muted={!current.lcp} />
            <Metric label="CLS" value={current.cls.toFixed(3)} />
            <Metric label={t('perf.route.emptyPaint')} value={formatMs(emptyPaint?.atMs)} muted={!emptyPaint} />
          </div>

          {fullGitWhileChat.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
              {t('perf.route.gitFullInChat', { count: fullGitWhileChat.length })}
            </div>
          )}

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.55fr)]">
            <div className="border rounded-md overflow-hidden">
              <div className="border-b bg-muted/40 px-2 py-1.5 text-xs font-medium">
                {t('perf.route.timeline')}
              </div>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/70 text-muted-foreground">
                    <tr>
                      <th className="py-1.5 px-2 text-left">{t('perf.route.event')}</th>
                      <th className="px-2 text-right">{t('perf.route.at')}</th>
                      <th className="px-2 text-right">{t('perf.route.duration')}</th>
                      <th className="px-2 text-left">{t('perf.route.detail')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td className="py-1 px-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className={kindClass(row.kind)}>{row.kind}</span>
                            <span className="truncate font-mono">{row.name}</span>
                          </div>
                        </td>
                        <td className="px-2 text-right tabular-nums">{formatMs(row.atMs)}</td>
                        <td className="px-2 text-right tabular-nums">{formatMs(row.durationMs)}</td>
                        <td className="px-2 text-muted-foreground">{row.detail ?? row.status ?? ''}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-2 px-2 text-muted-foreground">
                          {t('perf.route.noEvents')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-3">
              <div className="border rounded-md overflow-hidden">
                <div className="border-b bg-muted/40 px-2 py-1.5 text-xs font-medium">
                  {t('perf.route.topSpans')}
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="py-1.5 px-2 text-left">{t('perf.route.event')}</th>
                      <th className="px-2 text-right">{t('perf.route.duration')}</th>
                      <th className="px-2 text-left">{t('perf.route.status')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {topSpans.map((span) => (
                      <tr key={span.id}>
                        <td className="py-1 px-2 font-mono">{span.name}</td>
                        <td className="px-2 text-right tabular-nums">{formatMs(span.durationMs)}</td>
                        <td className="px-2 text-muted-foreground">{span.status}</td>
                      </tr>
                    ))}
                    {topSpans.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-2 px-2 text-muted-foreground">
                          {t('perf.route.noSpans')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="border rounded-md p-2 text-xs">
                <div className="mb-2 font-medium">{t('perf.route.vitals')}</div>
                <div className="space-y-1 text-muted-foreground">
                  <div>{t('perf.route.lcpElement')}: {current.lcp?.selector ?? '-'}</div>
                  <div>{t('perf.route.lcpText')}: {current.lcp?.text ?? '-'}</div>
                  <div>
                    {t('perf.route.longTaskMax')}: {maxLongTask ? `${formatMs(maxLongTask.durationMs)} @ ${formatMs(maxLongTask.atMs)}` : '-'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="border rounded-md px-2 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={muted ? 'text-sm text-muted-foreground' : 'text-sm font-medium'}>{value}</div>
    </div>
  );
}

function buildTimeline(sample?: RouteStartupSample): TimelineRow[] {
  if (!sample) {
    return [];
  }
  const rows: TimelineRow[] = [
    ...sample.events.map((event) => ({
      id: `event-${event.id}`,
      kind: 'event' as const,
      name: event.name,
      atMs: event.atMs,
      detail: event.meta?.detail ?? event.meta?.phase ?? event.meta?.source,
    })),
    ...sample.spans.map((span) => ({
      id: `span-${span.id}`,
      kind: 'span' as const,
      name: span.name,
      atMs: span.startMs,
      durationMs: span.durationMs,
      status: span.status,
      detail: span.meta?.detail ?? span.meta?.cache ?? span.status,
    })),
    ...sample.vitals.map((vital) => ({
      id: `vital-${vital.id}`,
      kind: 'vital' as const,
      name: vital.name,
      atMs: vital.atMs,
      durationMs: vital.durationMs,
      detail: vital.name === 'LCP'
        ? vital.selector
        : typeof vital.meta?.entryName === 'string'
          ? vital.meta.entryName
          : undefined,
    })),
  ];
  return rows.sort((a, b) => a.atMs - b.atMs);
}

function kindClass(kind: TimelineRow['kind']): string {
  if (kind === 'span') {
    return 'rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] uppercase text-blue-600 dark:text-blue-300';
  }
  if (kind === 'vital') {
    return 'rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase text-amber-700 dark:text-amber-300';
  }
  return 'rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground';
}

function formatMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  if (value >= 10_000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  if (value >= 1_000) {
    return `${Math.round(value)}ms`;
  }
  return `${Math.round(value * 10) / 10}ms`;
}
