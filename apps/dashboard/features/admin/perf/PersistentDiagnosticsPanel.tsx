import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { apiBaseUrl } from '../../../lib/api-client.js';

interface RunSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  status: 'current' | 'closed' | 'interrupted';
  pid: number;
  sizeBytes: number;
  path: string;
}

interface ArchivedSample {
  at: number;
  main: {
    rssMB: number;
    loopP50Ms: number;
    loopP99Ms: number;
    loopMaxMs: number;
  };
  totalWorkingSetMB: number | null;
}

interface ArchivedFreeze {
  at: number;
  source: 'handler' | 'background' | 'event-loop' | 'renderer' | 'starved' | 'offloop';
  channel?: string;
  durationMs: number;
  detail?: string;
}

interface ArchivedRendererFreeze {
  id: string;
  at: number;
  durationMs: number;
  name: string;
  script?: string;
  kind: 'loaf' | 'longtask';
  blockingDurationMs?: number;
  forcedStyleAndLayoutDurationMs?: number;
}

interface ArchivedSlowCall {
  channel: string;
  count: number;
  totalMs: number;
  maxMs: number;
  p99: number;
}

interface RunDetail {
  run: RunSummary;
  samples: ArchivedSample[];
  freezes: ArchivedFreeze[];
  rendererFreezes: ArchivedRendererFreeze[];
  rendererFreezeSummary?: {
    count: number;
    persisted: number;
    retained: number;
    dropped: number;
    droppedBeforePersist: number;
    droppedFromDetail: number;
    unavailable: number;
    totalDurationMs: number;
    maxDurationMs: number;
    loafCount: number;
    longtaskCount: number;
    blockingDurationTotalMs: number;
    forcedStyleAndLayoutDurationTotalMs: number;
    firstAt: number | null;
    lastAt: number | null;
  };
  slowCalls: ArchivedSlowCall[];
  recordsRead: number;
  corruptLines: number;
  read?: {
    cutoffAt: number;
    dataThroughAt: number | null;
    complete: boolean;
    reasons: string[];
    filesAvailable: number;
    filesRead: number;
    bytesRead: number;
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const formatMs = (value: number): string => `${value} ms`;
const formatMB = (value: number): string => `${value} MB`;

export function PersistentDiagnosticsPanel() {
  const { t } = useTranslation('admin');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl()}/api/admin/perf/runs`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { currentRunId: string | null; runs: RunSummary[] };
      setRuns(body.runs);
      setSelectedId((previous) => {
        if (previous && body.runs.some((run) => run.id === previous)) return previous;
        return body.runs.find((run) => run.status === 'interrupted')?.id
          ?? body.currentRunId
          ?? body.runs[0]?.id
          ?? '';
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const loadDetail = useCallback(async (runId: string) => {
    if (!runId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl()}/api/admin/perf/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setDetail((await response.json()) as RunDetail);
    } catch (cause) {
      setDetail(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadRuns(); }, [loadRuns]);
  useEffect(() => { void loadDetail(selectedId); }, [loadDetail, selectedId]);

  const worstSamples = useMemo(
    () => [...(detail?.samples ?? [])].sort((a, b) => b.main.loopP99Ms - a.main.loopP99Ms).slice(0, 8),
    [detail],
  );
  const archivedFreezes = useMemo(() => [
    ...(detail?.freezes ?? []).map((event) => ({
      at: event.at,
      source: event.source,
      durationMs: event.durationMs,
      culprit: event.channel ?? event.detail ?? '—',
    })),
    ...(detail?.rendererFreezes ?? []).map((event) => ({
      at: event.at,
      source: 'renderer' as const,
      durationMs: event.durationMs,
      culprit: event.script ?? event.name,
    })),
  ].sort((a, b) => b.at - a.at).slice(0, 15), [detail]);

  const statusLabel = (status: RunSummary['status']) => {
    if (status === 'current') return t('perf.journal.statusCurrent');
    if (status === 'closed') return t('perf.journal.statusClosed');
    return t('perf.journal.statusInterrupted');
  };

  const exportDetail = () => {
    if (!detail) return;
    const exportedAt = Date.now();
    const payload = {
      ...detail,
      exportMetadata: {
        schemaVersion: 1,
        exportedAt,
        cutoffAt: detail.read?.cutoffAt ?? exportedAt,
        dataThroughAt: detail.read?.dataThroughAt ?? null,
        readComplete: detail.read?.complete ?? false,
        runComplete: detail.run.status !== 'current',
        completenessReasons: detail.read?.reasons ?? ['read-metadata-unavailable'],
      },
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `performance-run-${detail.run.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{t('perf.journal.title')}</h3>
          <p className="text-[11px] text-muted-foreground">{t('perf.journal.hint')}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-8 max-w-[360px] rounded-md border bg-background px-2 text-xs"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {statusLabel(run.status)} · {new Date(run.startedAt).toLocaleString()} · {t('perf.journal.pid')} {run.pid}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadDetail(selectedId)}>
            {loading ? t('perf.journal.loading') : t('perf.journal.refresh')}
          </Button>
          <Button size="sm" variant="outline" disabled={!detail} onClick={exportDetail}>
            {t('perf.journal.export')}
          </Button>
        </div>
      </div>

      {error && <div className="text-xs text-destructive">{error}</div>}
      {!detail && !loading && !error && (
        <div className="text-xs text-muted-foreground">{t('perf.journal.empty')}</div>
      )}

      {detail && (
        <>
          <div className="grid gap-2 text-xs sm:grid-cols-6">
            <div><span className="text-muted-foreground">{t('perf.journal.status')}:</span> {statusLabel(detail.run.status)}</div>
            <div><span className="text-muted-foreground">{t('perf.journal.records')}:</span> {detail.recordsRead}</div>
            <div><span className="text-muted-foreground">{t('perf.journal.size')}:</span> {formatBytes(detail.run.sizeBytes)}</div>
            <div><span className="text-muted-foreground">{t('perf.journal.corruptLines')}:</span> {detail.corruptLines}</div>
            <div>
              <span className="text-muted-foreground">{t('perf.journal.rendererFreezes')}:</span>{' '}
              {detail.rendererFreezeSummary
                ? `${detail.rendererFreezeSummary.retained}/${detail.rendererFreezeSummary.count}`
                : detail.rendererFreezes.length}
            </div>
            <div>
              <span className="text-muted-foreground">{t('perf.journal.read')}:</span>{' '}
              <span title={detail.read?.reasons.join(', ') || undefined}>
                {detail.read?.complete ? t('perf.journal.readComplete') : t('perf.journal.readPartial')}
              </span>
            </div>
          </div>
          <div className="break-all rounded bg-muted/30 px-2 py-1 font-mono text-[10px] text-muted-foreground">
            {t('perf.journal.path')}: {detail.run.path}
          </div>

          <div>
            <h4 className="mb-2 text-xs font-medium">{t('perf.journal.worstWindows')}</h4>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground"><tr>
                  <th className="px-2 py-1.5 text-left">{t('perf.tools.when')}</th>
                  <th className="px-2 text-right">{t('perf.tools.p50')}</th>
                  <th className="px-2 text-right">{t('perf.tools.p99')}</th>
                  <th className="px-2 text-right">{t('perf.tools.maxMs')}</th>
                  <th className="px-2 text-right">{t('perf.journal.mainRss')}</th>
                  <th className="px-2 text-right">{t('perf.journal.totalRss')}</th>
                </tr></thead>
                <tbody className="divide-y">
                  {worstSamples.map((sample) => <tr key={sample.at}>
                    <td className="whitespace-nowrap px-2 py-1">{new Date(sample.at).toLocaleTimeString()}</td>
                    <td className="px-2 text-right tabular-nums">{formatMs(sample.main.loopP50Ms)}</td>
                    <td className="px-2 text-right tabular-nums">{formatMs(sample.main.loopP99Ms)}</td>
                    <td className="px-2 text-right tabular-nums">{formatMs(sample.main.loopMaxMs)}</td>
                    <td className="px-2 text-right tabular-nums">{formatMB(sample.main.rssMB)}</td>
                    <td className="px-2 text-right tabular-nums">{sample.totalWorkingSetMB == null ? '—' : formatMB(sample.totalWorkingSetMB)}</td>
                  </tr>)}
                  {worstSamples.length === 0 && <tr><td colSpan={6} className="px-2 py-2 text-muted-foreground">{t('perf.journal.noSamples')}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-medium">{t('perf.journal.archivedFreezes')}</h4>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground"><tr>
                  <th className="px-2 py-1.5 text-left">{t('perf.tools.when')}</th>
                  <th className="px-2 text-left">{t('perf.tools.source')}</th>
                  <th className="px-2 text-right">{t('perf.tools.durationMs')}</th>
                  <th className="px-2 text-left">{t('perf.tools.culprit')}</th>
                </tr></thead>
                <tbody className="divide-y">
                  {archivedFreezes.map((event, index) => <tr key={`${event.at}-${index}`}>
                    <td className="whitespace-nowrap px-2 py-1">{new Date(event.at).toLocaleTimeString()}</td>
                    <td className="px-2">{event.source}</td>
                    <td className="px-2 text-right tabular-nums">{event.durationMs}</td>
                    <td className="px-2 font-mono break-all">{event.culprit}</td>
                  </tr>)}
                  {archivedFreezes.length === 0 && <tr><td colSpan={4} className="px-2 py-2 text-muted-foreground">{t('perf.journal.noFreezes')}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-medium">{t('perf.journal.archivedSlowCalls')}</h4>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground"><tr>
                  <th className="px-2 py-1.5 text-left">{t('perf.tools.channel')}</th>
                  <th className="px-2 text-right">{t('perf.tools.calls')}</th>
                  <th className="px-2 text-right">{t('perf.tools.p99')}</th>
                  <th className="px-2 text-right">{t('perf.tools.maxMs')}</th>
                  <th className="px-2 text-right">{t('perf.tools.totalMs')}</th>
                </tr></thead>
                <tbody className="divide-y">
                  {detail.slowCalls.slice(0, 10).map((row) => <tr key={row.channel}>
                    <td className="px-2 py-1 font-mono">{row.channel}</td>
                    <td className="px-2 text-right tabular-nums">{row.count}</td>
                    <td className="px-2 text-right tabular-nums">{row.p99}</td>
                    <td className="px-2 text-right tabular-nums">{row.maxMs}</td>
                    <td className="px-2 text-right tabular-nums">{row.totalMs}</td>
                  </tr>)}
                  {detail.slowCalls.length === 0 && <tr><td colSpan={5} className="px-2 py-2 text-muted-foreground">{t('perf.journal.noSlowCalls')}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
