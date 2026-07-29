/**
 * CodeStudio's task manager — the Chrome-style process window (Shift+Esc).
 *
 * Shows the app's whole process tree: main, renderers, GPU, utility, worker
 * isolates, and every OS child the IDE spawned — terminals and their
 * grandchildren (npm → vite → esbuild), LSP servers, git, debug adapters, MCP
 * stdio servers. None of that is visible to `app.getAppMetrics()`, which is
 * why the backend runs its own process census.
 *
 * There is no "Network" column: Windows exposes no per-process network
 * counter without ETW or a filter driver (Chrome only manages it by
 * instrumenting its own stack). Disk I/O takes that slot instead — it comes
 * free with the same census and catches the runaway watcher just as well.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, XCircle } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { confirm, toast } from '../../components/ui/prompt-dialog.js';
import { ProcessRows } from './ProcessRows.js';
import { useProcessCensus } from './useProcessCensus.js';
import {
  REFRESH_OPTIONS, compareRows, formatCpu, formatInterval, formatMemory,
  type SortDir, type SortKey, type TaskRow,
} from './columns.js';

export default function TaskManagerPanel() {
  const { t } = useTranslation('admin');
  const [intervalMs, setIntervalMs] = useState<number>(2_000);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const { snapshot, error, refresh, kill } = useProcessCensus(intervalMs);

  // Filtering flattens the tree for the same reason sorting does: a match deep
  // in a subtree is meaningless if its ancestors are gone, and showing the
  // ancestors would show non-matching rows.
  const rows = useMemo(() => {
    const all = snapshot?.rows ?? [];
    const needle = filter.trim().toLowerCase();
    const visible = needle
      ? all.filter((row) => `${row.label} ${row.exe} ${row.command ?? ''} ${row.pid}`
        .toLowerCase().includes(needle))
      : all;
    if (sortKey === null) return visible;
    return [...visible].sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [snapshot, filter, sortKey, sortDir]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const onSort = (key: SortKey): void => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      // Third click restores the hierarchy instead of cycling forever.
      setSortKey(null);
    }
  };

  const endTask = async (row: TaskRow | null): Promise<void> => {
    if (!row || !row.killable || busy) return;
    const ok = await confirm({
      title: t('processes.kill.title'),
      description: t('processes.kill.confirm', { label: row.label, pid: row.pid }),
      confirmLabel: t('processes.kill.action'),
      tone: 'destructive',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const outcome = await kill(row.pid, 'force');
      if (outcome.ok) toast.success(t('processes.kill.done', { label: row.label }));
      else {
        toast.error(t('processes.kill.failed'), {
          description: outcome.code
            ? t(`processes.deny.${outcome.code}`, { defaultValue: outcome.code })
            : outcome.message,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const status = snapshot?.status;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('processes.filterPlaceholder')}
          className="h-7 min-w-[180px] flex-1 rounded-md border bg-background px-2 text-xs"
        />
        <select
          value={intervalMs}
          onChange={(e) => setIntervalMs(Number(e.target.value))}
          className="h-7 rounded-md border bg-background px-2 text-xs"
          aria-label={t('processes.intervalLabel')}
        >
          {REFRESH_OPTIONS.map((ms) => (
            <option key={ms} value={ms}>{formatInterval(ms)}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={refresh}>
          <RefreshCw className="mr-1 h-3 w-3" />
          {t('processes.refresh')}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="h-7 px-2 text-[11px]"
          disabled={!selected?.killable || busy}
          title={selected && !selected.killable && selected.killReason
            ? t(`processes.deny.${selected.killReason}`, { defaultValue: selected.killReason })
            : undefined}
          onClick={() => void endTask(selected)}
        >
          <XCircle className="mr-1 h-3 w-3" />
          {t('processes.kill.action')}
        </Button>
      </div>

      {status === 'warming' && (
        <div className="text-[11px] text-muted-foreground">{t('processes.warming')}</div>
      )}
      {status === 'failed' && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">{t('processes.failed')}</div>
      )}
      {error && <div className="text-[11px] text-destructive">{error}</div>}

      <ProcessRows
        rows={rows}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onActivate={(row) => void endTask(row)}
      />

      {snapshot && (
        <div className="flex shrink-0 items-center gap-4 text-[11px] text-muted-foreground tabular-nums">
          <span>{t('processes.totals.count', { count: snapshot.totals.count })}</span>
          <span>{`${t('processes.col.memory')}: ${formatMemory(snapshot.totals.memoryMB)}`}</span>
          <span>{`CPU: ${formatCpu(snapshot.totals.cpuPercent)}`}</span>
        </div>
      )}
    </div>
  );
}
