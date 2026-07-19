/**
 * Profiling tools: on-demand CPU profile (main OR renderer), full-app trace
 * (contentTracing → Perfetto), heap snapshot, the slow-IPC percentile table,
 * and a unified "Freezes" panel merging main-thread stalls (attributed to the
 * in-flight IPC handler) with renderer Long-Animation-Frame script attribution.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { apiBaseUrl } from '../../../lib/api-client.js';
import { getLongTasks, clearLongTasks } from './renderer-vitals.js';
import { RouteStartupPanel } from './RouteStartupPanel.js';
import { PersistentDiagnosticsPanel } from './PersistentDiagnosticsPanel.js';

interface SlowCallRow {
  channel: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastAt: number;
  p50: number;
  p95: number;
  p99: number;
}

interface FreezeRow {
  at: number;
  source: 'handler' | 'event-loop' | 'renderer' | 'starved' | 'offloop';
  durationMs: number;
  culprit: string;
}

type CpuTarget = 'main' | 'renderer';

export function ProfilingTools() {
  const { t } = useTranslation('admin');
  const [profiling, setProfiling] = useState(false);
  const [cpuTarget, setCpuTarget] = useState<CpuTarget>('main');
  const [durationS, setDurationS] = useState(10);
  const [snapshotPath, setSnapshotPath] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [tracing, setTracing] = useState(false);
  const [tracePath, setTracePath] = useState<string | null>(null);
  const [slowCalls, setSlowCalls] = useState<SlowCallRow[]>([]);
  const [freezes, setFreezes] = useState<FreezeRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadSlowCalls = async () => {
    try {
      const r = await fetch(`${apiBaseUrl()}/api/admin/perf/slow-ipc`);
      if (r.ok) setSlowCalls(((await r.json()) as { rows: SlowCallRow[] }).rows);
    } catch { /* transient */ }
  };

  // Merge main-process freezes (attributed to the in-flight IPC handler) with
  // renderer LoAF rows (attributed to the blocking script) into one list.
  const loadFreezes = async () => {
    let mainRows: FreezeRow[] = [];
    try {
      const r = await fetch(`${apiBaseUrl()}/api/admin/perf/freezes`);
      if (r.ok) {
        const body = (await r.json()) as {
          events: Array<{ source: 'handler' | 'event-loop' | 'starved' | 'offloop'; channel?: string; durationMs: number; at: number; detail?: string; count?: number }>;
        };
        mainRows = body.events.map((e) => ({
          at: e.at,
          source: e.source,
          durationMs: e.durationMs,
          culprit: (e.channel ?? e.detail ?? '—') + (e.count && e.count > 1 ? ` ×${e.count}` : ''),
        }));
      }
    } catch { /* transient */ }
    const rendererRows: FreezeRow[] = getLongTasks().map((r) => ({
      at: r.at,
      source: 'renderer',
      durationMs: r.durationMs,
      culprit: r.script ?? r.name,
    }));
    setFreezes([...mainRows, ...rendererRows].sort((a, b) => b.at - a.at).slice(0, 25));
  };

  useEffect(() => {
    void loadSlowCalls();
    void loadFreezes();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadSlowCalls();
      void loadFreezes();
    }, 10_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const runCpuProfile = async () => {
    setProfiling(true);
    setError(null);
    try {
      const route = cpuTarget === 'renderer' ? 'renderer-profile' : 'cpu-profile';
      const r = await fetch(`${apiBaseUrl()}/api/admin/perf/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: durationS * 1000 }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${r.status}`);
      const blob = new Blob([await r.text()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${cpuTarget}-${Date.now()}.cpuprofile`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProfiling(false);
    }
  };

  const runFullTrace = async () => {
    setTracing(true);
    setError(null);
    setTracePath(null);
    try {
      const r = await fetch(`${apiBaseUrl()}/api/admin/perf/full-trace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: durationS * 1000 }),
      });
      const body = (await r.json()) as { path?: string; error?: string };
      if (!r.ok || !body.path) throw new Error(body.error ?? `HTTP ${r.status}`);
      setTracePath(body.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTracing(false);
    }
  };

  const runHeapSnapshot = async () => {
    if (!(await confirm({
      title: t('perf.tools.heapSnapshot'),
      description: t('perf.tools.heapSnapshotConfirm'),
      confirmLabel: t('perf.tools.heapSnapshot'),
    }))) return;
    setSnapshotBusy(true);
    setError(null);
    try {
      const r = await fetch(`${apiBaseUrl()}/api/admin/perf/heap-snapshot`, { method: 'POST' });
      const body = (await r.json()) as { path?: string; error?: string };
      if (!r.ok || !body.path) throw new Error(body.error ?? `HTTP ${r.status}`);
      setSnapshotPath(body.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSnapshotBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={durationS}
          onChange={(e) => setDurationS(Number(e.target.value))}
        >
          <option value={5}>{'5s'}</option>
          <option value={10}>{'10s'}</option>
          <option value={30}>{'30s'}</option>
        </select>
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={cpuTarget}
          onChange={(e) => setCpuTarget(e.target.value as CpuTarget)}
        >
          <option value="main">{t('perf.tools.cpuTargetMain')}</option>
          <option value="renderer">{t('perf.tools.cpuTargetRenderer')}</option>
        </select>
        <Button size="sm" variant="outline" disabled={profiling} onClick={() => void runCpuProfile()}>
          {profiling ? t('perf.tools.cpuProfileRunning') : t('perf.tools.cpuProfile')}
        </Button>
        <Button size="sm" variant="outline" disabled={tracing} onClick={() => void runFullTrace()}>
          {tracing ? t('perf.tools.fullTraceRunning') : t('perf.tools.fullTrace')}
        </Button>
        <Button size="sm" variant="outline" disabled={snapshotBusy} onClick={() => void runHeapSnapshot()}>
          {snapshotBusy ? t('perf.tools.heapSnapshotRunning') : t('perf.tools.heapSnapshot')}
        </Button>
        <span className="text-[11px] text-muted-foreground">{t('perf.tools.cpuProfileHint')}</span>
      </div>
      {tracePath && (
        <div className="text-xs border rounded-md p-2 bg-muted/30 font-mono break-all">
          {t('perf.tools.fullTraceSaved')}: {tracePath}
        </div>
      )}
      {snapshotPath && (
        <div className="text-xs border rounded-md p-2 bg-muted/30 font-mono break-all">
          {t('perf.tools.heapSnapshotSaved')}: {snapshotPath}
        </div>
      )}
      {error && <div className="text-xs text-destructive">{error}</div>}

      <PersistentDiagnosticsPanel />

      <RouteStartupPanel />

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">{t('perf.tools.freezesTitle')}</h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void fetch(`${apiBaseUrl()}/api/admin/perf/freezes/reset`, { method: 'POST' })
                .then(() => { clearLongTasks(); return loadFreezes(); });
            }}
          >
            {t('perf.tools.reset')}
          </Button>
        </div>
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="py-1.5 px-2 text-left">{t('perf.tools.when')}</th>
                <th className="px-2 text-left">{t('perf.tools.source')}</th>
                <th className="px-2 text-right">{t('perf.tools.durationMs')}</th>
                <th className="px-2 text-left">{t('perf.tools.culprit')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {freezes.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className="py-1 px-2 whitespace-nowrap">{new Date(r.at).toLocaleTimeString()}</td>
                  <td className="px-2">{r.source}</td>
                  <td className="px-2 text-right tabular-nums">{r.durationMs}</td>
                  <td className="px-2 font-mono break-all">{r.culprit}</td>
                </tr>
              ))}
              {freezes.length === 0 && (
                <tr><td colSpan={4} className="py-2 px-2 text-muted-foreground">{t('perf.tools.freezesEmpty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">{t('perf.tools.slowIpcTitle')}</h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void fetch(`${apiBaseUrl()}/api/admin/perf/slow-ipc/reset`, { method: 'POST' }).then(loadSlowCalls);
            }}
          >
            {t('perf.tools.reset')}
          </Button>
        </div>
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="py-1.5 px-2 text-left">{t('perf.tools.channel')}</th>
                <th className="px-2 text-right">{t('perf.tools.calls')}</th>
                <th className="px-2 text-right">{t('perf.tools.totalMs')}</th>
                <th className="px-2 text-right">{t('perf.tools.p50')}</th>
                <th className="px-2 text-right">{t('perf.tools.p95')}</th>
                <th className="px-2 text-right">{t('perf.tools.p99')}</th>
                <th className="px-2 text-right">{t('perf.tools.maxMs')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {slowCalls.map((r) => (
                <tr key={r.channel}>
                  <td className="py-1 px-2 font-mono">{r.channel}</td>
                  <td className="px-2 text-right tabular-nums">{r.count}</td>
                  <td className="px-2 text-right tabular-nums">{r.totalMs}</td>
                  <td className="px-2 text-right tabular-nums">{r.p50}</td>
                  <td className="px-2 text-right tabular-nums">{r.p95}</td>
                  <td className="px-2 text-right tabular-nums">{r.p99}</td>
                  <td className="px-2 text-right tabular-nums">{r.maxMs}</td>
                </tr>
              ))}
              {slowCalls.length === 0 && (
                <tr><td colSpan={7} className="py-2 px-2 text-muted-foreground">{t('perf.tools.slowIpcEmpty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
