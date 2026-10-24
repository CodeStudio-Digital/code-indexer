/**
 * The process table. Sorted by a column it flattens into a plain ranking
 * (Chrome does the same); unsorted it keeps the parent/child indentation that
 * makes "this vite belongs to that terminal" legible.
 */
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { KindIcon } from './kind-icon.js';
import {
  formatCpu, formatDisk, formatMemory,
  type SortDir, type SortKey, type TaskRow,
} from './columns.js';

interface SortHeaderProps {
  label: string;
  k: SortKey;
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}

function SortHeader({ label, k, sortKey, sortDir, onSort, align = 'left' }: SortHeaderProps) {
  const active = sortKey === k;
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={cn('py-1.5 px-2 font-medium', align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex items-center gap-1 uppercase tracking-wider transition-colors',
          active ? 'text-foreground' : 'hover:text-foreground',
        )}
      >
        <span>{label}</span>
        <Icon className={cn('h-3 w-3', !active && 'opacity-40')} />
      </button>
    </th>
  );
}

interface ProcessRowsProps {
  rows: TaskRow[];
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Fires on double-click, mirroring the "end task" button. */
  onActivate: (row: TaskRow) => void;
}

export function ProcessRows(props: ProcessRowsProps) {
  const { t } = useTranslation('admin');
  const { rows, sortKey, sortDir, onSort, selectedId, onSelect, onActivate } = props;
  const flattened = sortKey !== null;

  return (
    <div className="border rounded-md overflow-auto min-h-0 flex-1">
      <table className="w-full text-xs">
        <thead className="bg-muted/50 text-muted-foreground sticky top-0 z-10">
          <tr>
            <SortHeader label={t('processes.col.task')} k="label" {...{ sortKey, sortDir, onSort }} />
            <SortHeader label={t('processes.col.type')} k="kind" {...{ sortKey, sortDir, onSort }} />
            <SortHeader label={'PID'} k="pid" align="right" {...{ sortKey, sortDir, onSort }} />
            <SortHeader label={t('processes.col.memory')} k="memoryMB" align="right" {...{ sortKey, sortDir, onSort }} />
            <SortHeader label={'CPU'} k="cpuPercent" align="right" {...{ sortKey, sortDir, onSort }} />
            <SortHeader label={t('processes.col.disk')} k="diskBytesPerSec" align="right" {...{ sortKey, sortDir, onSort }} />
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onSelect(row.id)}
              onDoubleClick={() => onActivate(row)}
              className={cn(
                'cursor-default',
                selectedId === row.id ? 'bg-accent' : 'hover:bg-muted/40',
                row.source === 'worker' && 'text-muted-foreground',
              )}
            >
              <td className="py-1 px-2">
                <div
                  className="flex items-center gap-1.5 min-w-0"
                  style={{ paddingLeft: flattened ? 0 : row.depth * 14 }}
                >
                  <KindIcon kind={row.kind} className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  {/* The command line is the tooltip, not a column — it is what
                      tells one anonymous node.exe from another. */}
                  <span className="truncate" title={row.command || row.exe}>{row.label}</span>
                  {row.orphaned && (
                    <span
                      className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-600 dark:text-amber-400"
                      title={t('processes.orphanHint')}
                    >
                      {t('processes.orphanBadge')}
                    </span>
                  )}
                </div>
              </td>
              <td className="px-2 text-muted-foreground">{t(`processes.kind.${row.kind}`)}</td>
              <td className="px-2 text-right tabular-nums">
                {row.source === 'worker' ? '—' : row.pid}
              </td>
              <td className="px-2 text-right tabular-nums">{formatMemory(row.memoryMB)}</td>
              <td className="px-2 text-right tabular-nums">{formatCpu(row.cpuPercent)}</td>
              <td className="px-2 text-right tabular-nums">{formatDisk(row.diskBytesPerSec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
