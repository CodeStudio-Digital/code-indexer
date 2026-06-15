/**
 * Profiling tools section: on-demand CPU profile (downloads .cpuprofile),
 * heap snapshot (confirm-gated — blocks the main process), slow-IPC top
 * list and renderer long-task list.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { apiBaseUrl } from '../../../lib/api-client.js';
import { ensureRendererVitals, getLongTasks, type LongTaskRow } from './renderer-vitals.js';

interface SlowCallRow {
  channel: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastAt: number;
}

export function ProfilingTools() {
  const { t } = useTranslation('admin');
  const [profiling, setProfiling] = useState(false);
  const [durationS, setDurationS] = useState(10);
  const [snapshotPath, setSnapshotPath] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [slowCalls, setSlowCalls] = useState<SlowCallRow[]>([]);
  const [longTasks, setLongTasks] = useState<LongTaskRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadSlowCalls = async () => {
    try {
      const r = await fetch(`${apiBaseUrl()}/api/admin/perf/slow-ipc`);
      if (r.ok) setSlowCalls(((await r.json()) as { rows: SlowCallRow[] }).rows);
    } catch { /* transient */ }
  };

  useEffect(() => {
    ensureRendererVitals();
    void loadSlowCalls();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadSlowCalls();
      setLongTasks(getLongTasks());
    }, 5_000);
    setLongTasks(getLongTasks());
    return () => clearInterval(timer);
  }, []);

  const runCpuProfile = async () => {
    setProfiling(true);
    setError(null);
    try {
      const r = await fetch(`${apiBaseUrl()}/api/admin/perf/cpu-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: durationS * 1000 }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = new Blob([await r.text()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `main-${Date.now()}.cpuprofile`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProfiling(false);
    }
  };

  const runHeapSnapshot = async () => {
    if (!window.confirm(t('perf.tools.heapSnapshotConfirm'))) return;
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
        <Button size="sm" variant="outline" disabled={profiling} onClick={() => void runCpuProfile()}>
          {profiling ? t('perf.tools.cpuProfileRunning') : t('perf.tools.cpuProfile')}
        </Button>
        <Button size="sm" variant="outline" disabled={snapshotBusy} onClick={() => void runHeapSnapshot()}>
          {snapshotBusy ? t('perf.tools.heapSnapshotRunning') : t('perf.tools.heapSnapshot')}
        </Button>
        <span className="text-[11px] text-muted-foreground">{t('perf.tools.cpuProfileHint')}</span>
      </div>
      {snapshotPath && (
        <div className="text-xs border rounded-md p-2 bg-muted/30 font-mono break-all">
          {t('perf.tools.heapSnapshotSaved')}: {snapshotPath}
        </div>
      )}
      {error && <div className="text-xs text-destructive">{error}</div>}

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
                <th className="px-2 text-right">{t('perf.tools.maxMs')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {slowCalls.map((r) => (
                <tr key={r.channel}>
                  <td className="py-1 px-2 font-mono">{r.channel}</td>
                  <td className="px-2 text-right">{r.count}</td>
                  <td className="px-2 text-right">{r.totalMs}</td>
                  <td className="px-2 text-right">{r.maxMs}</td>
                </tr>
              ))}
              {slowCalls.length === 0 && (
                <tr><td colSpan={4} className="py-2 px-2 text-muted-foreground">{t('perf.tools.slowIpcEmpty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">{t('perf.tools.longTasksTitle')}</h3>
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="py-1.5 px-2 text-left">{t('perf.tools.when')}</th>
                <th className="px-2 text-right">{t('perf.tools.durationMs')}</th>
                <th className="px-2 text-left">{t('perf.tools.attribution')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {longTasks.slice(0, 15).map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className="py-1 px-2">{new Date(r.at).toLocaleTimeString()}</td>
                  <td className="px-2 text-right">{r.durationMs}</td>
                  <td className="px-2 font-mono">{r.name}</td>
                </tr>
              ))}
              {longTasks.length === 0 && (
                <tr><td colSpan={3} className="py-2 px-2 text-muted-foreground">{t('perf.tools.longTasksEmpty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
