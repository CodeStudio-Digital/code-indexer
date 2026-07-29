/**
 * Admin → Performance panel. Answers two questions:
 *   1. WHERE is the memory (process tree + worker isolates + subsystem
 *      ledger + renderer/Monaco)
 *   2. WHAT is slow (event-loop lag, slow IPC calls, long tasks, CPU
 *      profile / heap snapshot on demand)
 */
import { useTranslation } from 'react-i18next';
import { ListTree } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { openDetached } from '../../popout/openDetached.js';
import { usePerfMonitor } from './usePerfMonitor.js';
import { ProcessTreeTable } from './ProcessTreeTable.js';
import { LedgerAndHistory } from './LedgerAndHistory.js';
import { ProfilingTools } from './ProfilingTools.js';

function LagBadge({ label, p99 }: { label: string; p99: number }) {
  const tone =
    p99 < 50 ? 'text-emerald-500' : p99 < 200 ? 'text-amber-500' : 'text-destructive';
  return (
    <div className="border rounded-md px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold ${tone}`}>{`p99 ${p99} ms`}</div>
    </div>
  );
}

export default function PerfMonitorPanel() {
  const { t } = useTranslation('admin');
  const { sample, history, renderer, error } = usePerfMonitor();

  if (error && !sample) {
    return <div className="text-sm text-destructive">{t('perf.error')}: {error}</div>;
  }
  if (!sample) {
    return <div className="text-sm text-muted-foreground">{t('perf.loading')}</div>;
  }

  const workerLags = [
    ...sample.workers.company.map((w) => w.stats?.loopP99Ms ?? 0),
    ...sample.workers.coder.map((w) => w.stats?.loopP99Ms ?? 0),
    ...(sample.workers.indexer ? [sample.workers.indexer.loopP99Ms] : []),
  ];
  const maxWorkerLag = workerLags.length ? Math.max(...workerLags) : null;

  return (
    <div className="space-y-6">
      {/* Event-loop lag — main backend roda in-process: lag alto AQUI é a
          causa direta de "o app está lento". */}
      <div className="flex flex-wrap gap-2">
        <LagBadge label={t('perf.lag.main')} p99={sample.main.loopP99Ms} />
        {maxWorkerLag != null && <LagBadge label={t('perf.lag.workers')} p99={maxWorkerLag} />}
        {renderer?.jsHeapUsedMB != null && (
          <div className="border rounded-md px-3 py-2">
            <div className="text-[11px] text-muted-foreground">{t('perf.renderer.jsHeap')}</div>
            <div className="text-sm font-semibold">
              {`${renderer.jsHeapUsedMB} / ${renderer.jsHeapTotalMB} MB`}
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('perf.processes.title')}</h3>
          {/* This table is the memory-attribution view (worker isolates the OS
              cannot see). The live task manager is a separate window — link to
              it here, since it has no entry in the admin rail. */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            title={t('processes.openHint')}
            onClick={() => openDetached(
              'task-manager',
              {},
              // Browser/dev has no Electron window API — a tab is the closest
              // thing to a companion window there.
              () => window.open('/popout/task-manager', '_blank', 'noopener'),
            )}
          >
            <ListTree className="mr-1 h-3 w-3" />
            {t('processes.open')}
          </Button>
        </div>
        <ProcessTreeTable sample={sample} />
      </div>

      <LedgerAndHistory sample={sample} history={history} renderer={renderer} />

      <div>
        <h3 className="text-sm font-medium mb-2">{t('perf.tools.title')}</h3>
        <ProfilingTools />
      </div>
    </div>
  );
}
