/**
 * Process tree table — the "where are the 4GB" view. One row per Electron
 * child process (from app.getAppMetrics), worker-thread isolates nested
 * under the main process, and the renderer row annotated with its local
 * JS heap. The total row should track Task Manager's process-group sum.
 */
import { useTranslation } from 'react-i18next';
import type { PerfSample, RendererStats, WorkerMemStats } from './usePerfMonitor.js';

function WorkerRow({ label, stats }: { label: string; stats: WorkerMemStats | null }) {
  const { t } = useTranslation('admin');
  return (
    <tr className="text-muted-foreground">
      <td className="py-1 pl-8 pr-2">{`↳ ${label}`}</td>
      <td className="px-2">{'worker_thread'}</td>
      <td className="px-2 text-right">—</td>
      <td className="px-2 text-right">
        {stats ? (
          <span title={t('perf.workers.heapLimitHint', { limit: stats.heapLimitMB })}>
            {`${stats.heapUsedMB} / ${stats.heapTotalMB} MB`}
          </span>
        ) : t('perf.workers.noData')}
      </td>
      <td className="px-2 text-right">{stats ? `${stats.loopP99Ms} ms` : '—'}</td>
    </tr>
  );
}

export function ProcessTreeTable({ sample }: { sample: PerfSample }) {
  const { t } = useTranslation('admin');
  const main = sample.main;
  const procs = sample.processes;
  const workerStats = [
    ...sample.workers.company.map((row) => row.stats),
    ...sample.workers.coder.map((row) => row.stats),
    sample.workers.indexer,
  ].filter((stats): stats is WorkerMemStats => stats != null);
  const fallbackWorkerHeapUsedMB = Math.round(
    workerStats.reduce((total, stats) => total + stats.heapUsedMB, 0) * 10,
  ) / 10;
  const fallbackWorkerHeapTotalMB = Math.round(
    workerStats.reduce((total, stats) => total + stats.heapTotalMB, 0) * 10,
  ) / 10;
  const workerHeapUsedMB = main.knownWorkerHeapUsedMB ?? fallbackWorkerHeapUsedMB;
  const workerHeapTotalMB = main.knownWorkerHeapTotalMB ?? fallbackWorkerHeapTotalMB;
  const rssLessMainHeapMB = main.rssLessMainHeapMB ?? main.nativeMB;
  const unattributedRssMB = main.unattributedRssMB
    ?? Math.max(0, Math.round((rssLessMainHeapMB - workerHeapTotalMB) * 10) / 10);

  return (
    <div className="border rounded-md overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="py-1.5 px-2 text-left">{t('perf.processes.process')}</th>
            <th className="px-2 text-left">{t('perf.processes.type')}</th>
            <th className="px-2 text-right">{'PID'}</th>
            <th className="px-2 text-right">{t('perf.processes.memory')}</th>
            <th className="px-2 text-right">{t('perf.processes.cpuOrLag')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {/* Main process — detailed from process.memoryUsage. */}
          <tr className="font-medium">
            <td className="py-1 px-2">{t('perf.processes.mainBackend')}</td>
            <td className="px-2">{'main'}</td>
            <td className="px-2 text-right">{main.pid}</td>
            <td className="px-2 text-right">
              {`${main.rssMB} MB`}
              <span
                className="text-muted-foreground font-normal"
                title={t('perf.main.memoryBreakdownHint', { limit: main.heapLimitMB })}
              >
                {` (${t('perf.main.heapShort')} ${main.heapUsedMB}/${main.heapTotalMB} · ${t('perf.main.workerHeapsShort')} ${workerHeapUsedMB}/${workerHeapTotalMB} · ${t('perf.main.rssResidualShort')} ${unattributedRssMB})`}
              </span>
            </td>
            <td className="px-2 text-right">{`p99 ${main.loopP99Ms} ms`}</td>
          </tr>
          {sample.workers.company.map((w) => (
            <WorkerRow key={`co-${w.sessionId}`} label={`company #${w.sessionId}`} stats={w.stats} />
          ))}
          {sample.workers.coder.map((w) => (
            <WorkerRow key={`cd-${w.sessionId}`} label={`coder #${w.sessionId}`} stats={w.stats} />
          ))}
          {sample.workers.indexer && <WorkerRow label="indexer" stats={sample.workers.indexer} />}

          {/* Electron children (renderer/GPU/utility) minus the main row
              (already detailed above). */}
          {procs
            ?.filter((p) => p.pid !== main.pid)
            .map((p) => (
              <tr key={p.pid}>
                <td className="py-1 px-2">{p.name || p.type}</td>
                <td className="px-2">{p.type}</td>
                <td className="px-2 text-right">{p.pid}</td>
                <td className="px-2 text-right">{`${p.workingSetMB} MB`}</td>
                <td className="px-2 text-right">{`${p.cpuPercent}%`}</td>
              </tr>
            ))}
          {!procs && (
            <tr>
              <td colSpan={5} className="py-2 px-2 text-muted-foreground">
                {t('perf.processes.unavailable')}
              </td>
            </tr>
          )}
        </tbody>
        {sample.totalWorkingSetMB != null && (
          <tfoot className="bg-muted/30 font-semibold">
            <tr>
              <td className="py-1.5 px-2" colSpan={3}>{t('perf.processes.total')}</td>
              <td className="px-2 text-right">{`${sample.totalWorkingSetMB} MB`}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
