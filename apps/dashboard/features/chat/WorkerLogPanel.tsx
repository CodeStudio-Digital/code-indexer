/**
 * Live worker-log inspector that runs side-by-side with the chat.
 *
 * Captures the diagnostic SSE timeline (tool/lifecycle boundaries, sampled
 * progress, quality verdicts, provider swaps, route hits emitted as
 * `worker_log`, pool spawn/crash). Raw text/thinking deltas are intentionally
 * omitted because the persisted/rendered chat is their canonical copy.
 *
 * UX:
 *   - Auto-scroll toggle (default ON)
 *   - Filter chips by category (route / pool / tool / quality / …)
 *   - Free-text search over `event` + `message`
 *   - Expand rows to see the raw payload as JSON
 *
 * The panel is dumb — it doesn't fetch anything. Entries come from the
 * dedicated `worker-log-store` (capped at 1000, coalesced) which only this
 * panel subscribes to, so incoming event bursts never re-render the
 * chat. The list is virtualized so 1000 rows stay cheap. Memoized so a
 * store commit only re-renders the rows that changed.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Download, GitBranch, Search, X } from 'lucide-react';
import type { WorkerLogEntry } from '../../hooks/agent-stream/types.js';
import { useWorkerLog } from '../../hooks/agent-stream/worker-log-store.js';
import { cn } from '../../lib/utils.js';
import { ExecutionMapPanel } from './ExecutionMapPanel.js';
import { WorkerLogRow, CATEGORY_COLORS, ALL_CATEGORIES } from './WorkerLogRow.js';
import { exportWorkerLogs } from './worker-log-export.js';

interface WorkerLogPanelProps {
  onClose: () => void;
  sessionId?: string | null;
  kind?: 'coder' | 'company';
  /** When true, drops the panel's own header chrome (the host provides one). */
  embedded?: boolean;
}

function WorkerLogPanelInner({ onClose, sessionId, kind = 'coder', embedded }: WorkerLogPanelProps) {
  const entries = useWorkerLog(sessionId ?? null);
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [view, setView] = useState<'log' | 'map'>('log');
  // Empty Set === "all categories". Once the user picks any, only those show.
  const [filterCats, setFilterCats] = useState<Set<WorkerLogEntry['category']>>(new Set());
  // Expanded rows keyed by composite `ts-event-idx` so re-renders don't lose state.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (filterCats.size > 0 && !filterCats.has(e.category)) return false;
      if (!s) return true;
      return e.event.toLowerCase().includes(s) || e.message.toLowerCase().includes(s);
    });
  }, [entries, search, filterCats]);

  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 22,
    overscan: 16,
    getItemKey: (i) => {
      const e = filtered[i];
      return `${e.ts}-${e.event}-${i}`;
    },
  });

  // Stick to the bottom as new entries arrive (unless the user turned it off).
  useEffect(() => {
    if (!autoScroll || filtered.length === 0) return;
    rowVirtualizer.scrollToIndex(filtered.length - 1, { align: 'end' });
  }, [filtered.length, autoScroll, rowVirtualizer]);

  const toggleCategory = useCallback((cat: WorkerLogEntry['category']) => {
    setFilterCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toolbar = (compact: boolean) => (
    <div className="ml-auto flex items-center gap-2">
      <button
        type="button"
        onClick={() => setView((v) => (v === 'log' ? 'map' : 'log'))}
        className="rounded p-1 hover:bg-muted"
        aria-label={view === 'log' ? 'Show execution map' : 'Show worker log'}
        title={view === 'log' ? 'Execution map' : 'Worker log'}
      >
        <GitBranch className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => { void exportWorkerLogs(entries, sessionId ?? null, kind); }}
        className="rounded p-1 hover:bg-muted"
        aria-label="Export worker logs"
        title="Export logs"
      >
        <Download className="h-3.5 w-3.5" />
      </button>
      <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
        <input
          type="checkbox"
          checked={autoScroll}
          onChange={(e) => setAutoScroll(e.target.checked)}
          className="h-3 w-3"
        />
        {compact ? 'auto' : 'auto-scroll'}
      </label>
      {!compact && (
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-muted" aria-label="Close worker log">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  const count = (
    <span className="text-[10px] text-muted-foreground">
      {entries.length} event{entries.length === 1 ? '' : 's'}
    </span>
  );

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col bg-[var(--workbench-surface)] text-card-foreground',
        !embedded && 'border-l border-border',
      )}
    >
      {!embedded ? (
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Worker Log</span>
          {count}
          {toolbar(false)}
        </header>
      ) : (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 shrink-0">
          {count}
          {toolbar(true)}
        </div>
      )}

      <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
        {ALL_CATEGORIES.map((cat) => {
          const dimmed = filterCats.size > 0 && !filterCats.has(cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() => toggleCategory(cat)}
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-[10px] transition-opacity',
                CATEGORY_COLORS[cat],
                dimmed && 'opacity-40',
              )}
              title={`Filter by ${cat}`}
            >
              {cat}
            </button>
          );
        })}
      </div>

      <div className="relative border-b border-border">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by event name or message…"
          className="w-full bg-transparent px-7 py-1.5 text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>

      {view === 'map' ? (
        <div className="min-h-0 flex-1">
          <ExecutionMapPanel entries={entries} />
        </div>
      ) : (
        <div ref={listRef} className="flex-1 overflow-y-auto font-mono text-[10px] leading-tight">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {entries.length === 0
                ? 'No events yet. Start a turn and the worker log will populate here.'
                : 'No events match the current filters.'}
            </div>
          ) : (
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const entry = filtered[vi.index];
                const key = `${entry.ts}-${entry.event}-${vi.index}`;
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                  >
                    <WorkerLogRow entry={entry} rowKey={key} expanded={expandedKeys.has(key)} onToggle={toggleExpand} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const WorkerLogPanel = memo(WorkerLogPanelInner);
