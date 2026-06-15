/**
 * Subsystem ledger table + 60-min memory sparkline (inline SVG — no chart
 * lib). The ledger rows come from MemoryLedger estimators on the backend;
 * renderer-local rows (Monaco, JS heap) are appended by the panel.
 */
import { useTranslation } from 'react-i18next';
import type { PerfHistoryPoint, PerfSample, RendererStats } from './usePerfMonitor.js';

function Sparkline({ points }: { points: PerfHistoryPoint[] }) {
  const { t } = useTranslation('admin');
  if (points.length < 2) {
    return <div className="text-xs text-muted-foreground">{t('perf.history.collecting')}</div>;
  }
  const W = 640;
  const H = 80;
  const series = (sel: (p: PerfHistoryPoint) => number | null): string => {
    const vals = points.map(sel);
    const max = Math.max(...vals.map((v) => v ?? 0), 1);
    return points
      .map((p, i) => {
        const v = sel(p);
        if (v == null) return null;
        const x = (i / (points.length - 1)) * W;
        const y = H - (v / max) * (H - 6) - 3;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');
  };
  const latest = points[points.length - 1];
  return (
    <div className="space-y-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20 border rounded-md bg-card/40">
        <polyline points={series((p) => p.totalWorkingSetMB)} fill="none" className="stroke-primary" strokeWidth="1.5" />
        <polyline points={series((p) => p.mainRssMB)} fill="none" className="stroke-amber-500" strokeWidth="1.5" />
        <polyline points={series((p) => p.mainHeapUsedMB)} fill="none" className="stroke-sky-500" strokeWidth="1.5" />
      </svg>
      <div className="flex gap-4 text-[11px] text-muted-foreground">
        <span><span className="inline-block w-2 h-2 rounded-full bg-primary mr-1" />{`${t('perf.history.totalTree')} ${latest.totalWorkingSetMB ?? '—'} MB`}</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1" />{`${t('perf.history.mainRss')} ${latest.mainRssMB} MB`}</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-sky-500 mr-1" />{`${t('perf.history.mainHeap')} ${latest.mainHeapUsedMB} MB`}</span>
      </div>
    </div>
  );
}

export function LedgerAndHistory({
  sample,
  history,
  renderer,
}: {
  sample: PerfSample;
  history: PerfHistoryPoint[];
  renderer: RendererStats | null;
}) {
  const { t } = useTranslation('admin');
  const rows = [
    ...sample.ledger,
    ...(renderer
      ? [
          {
            name: 'renderer.monaco',
            count: renderer.monacoModels,
            detail: t('perf.renderer.monacoDetail', {
              chars: renderer.monacoChars.toLocaleString(),
              viewStates: renderer.viewStates,
            }),
          },
          ...(renderer.jsHeapUsedMB != null
            ? [{
                name: 'renderer.jsHeap',
                count: 1,
                detail: `${renderer.jsHeapUsedMB} / ${renderer.jsHeapTotalMB} MB`,
              }]
            : []),
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-2">{t('perf.history.title')}</h3>
        <Sparkline points={history} />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">{t('perf.ledger.title')}</h3>
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="py-1.5 px-2 text-left">{t('perf.ledger.subsystem')}</th>
                <th className="px-2 text-right">{t('perf.ledger.count')}</th>
                <th className="px-2 text-left">{t('perf.ledger.detail')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className="py-1 px-2 font-mono">{r.name}</td>
                  <td className="px-2 text-right">{r.count}</td>
                  <td className="px-2 text-muted-foreground">{r.detail ?? ''}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-2 px-2 text-muted-foreground">{t('perf.ledger.empty')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
