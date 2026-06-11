/**
 * One row of the Worker Log, extracted + memoized so the virtualized list
 * only re-renders the rows whose data/expanded state actually changed. The
 * raw-payload `JSON.stringify` is memoized per entry and only runs while the
 * row is expanded (the common case is collapsed).
 */
import { memo, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { WorkerLogEntry } from '../../hooks/agent-stream/types.js';
import { cn } from '../../lib/utils.js';

/** Tailwind classes per category badge — shared with the panel's filter chips. */
export const CATEGORY_COLORS: Record<WorkerLogEntry['category'], string> = {
  route: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  pool: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  worker: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  runner: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  tool: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300',
  quality: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  provider: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  lifecycle: 'bg-slate-100 text-slate-800 dark:bg-slate-700/30 dark:text-slate-300',
  message: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300',
  other: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

const LEVEL_TEXT: Record<WorkerLogEntry['level'], string> = {
  info: 'text-foreground/80',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
  debug: 'text-blue-500',
};

export const ALL_CATEGORIES: readonly WorkerLogEntry['category'][] = [
  'route', 'pool', 'worker', 'runner', 'tool',
  'quality', 'provider', 'lifecycle', 'message', 'other',
];

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export const WorkerLogRow = memo(function WorkerLogRow({
  entry,
  rowKey,
  expanded,
  onToggle,
}: {
  entry: WorkerLogEntry;
  rowKey: string;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const headline = entry.event === 'worker_log' ? entry.message : entry.event;
  const json = useMemo(
    () => (expanded ? JSON.stringify(entry.data, null, 2) : ''),
    [expanded, entry],
  );
  return (
    <div className="border-b border-border/50 px-2 py-1 hover:bg-muted/30">
      <button
        type="button"
        onClick={() => onToggle(rowKey)}
        className="flex w-full items-start gap-1.5 text-left"
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 h-2.5 w-2.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-2.5 w-2.5 shrink-0 text-muted-foreground" />
        )}
        <span className="text-muted-foreground">{formatTime(entry.ts)}</span>
        <span className={cn('rounded px-1 font-mono text-[9px]', CATEGORY_COLORS[entry.category])}>
          {entry.category}
        </span>
        <span className={cn('flex-1 truncate', LEVEL_TEXT[entry.level])}>{headline}</span>
      </button>
      {expanded && (
        <pre className="ml-4 mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-1.5 text-[10px]">
          {json}
        </pre>
      )}
    </div>
  );
});
