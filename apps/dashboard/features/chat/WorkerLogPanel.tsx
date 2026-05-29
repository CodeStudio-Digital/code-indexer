/**
 * Live worker-log inspector that runs side-by-side with the chat.
 *
 * Captures every SSE event delivered by `useAgentStream` (text deltas,
 * tool calls, quality verdicts, provider swaps, route hits emitted as
 * `worker_log`, pool spawn/crash) into a chronological log so the user
 * can see exactly what the worker is doing — and, more importantly,
 * what it just stopped doing when a session looks stuck.
 *
 * UX:
 *   - Auto-scroll toggle (default ON; turns off when the user scrolls up)
 *   - Filter chips by category (route / pool / tool / quality / …)
 *   - Free-text search over `event` + `message`
 *   - Expand rows to see the raw payload as JSON
 *
 * The panel is dumb — it doesn't fetch anything. Entries come from
 * `SessionState.eventLog` which is capped at 1000 entries by
 * `openStream.ts` so memory stays bounded.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, GitBranch, Search, X } from 'lucide-react';
import type { WorkerLogEntry } from '../../hooks/agent-stream/types.js';
import { cn } from '../../lib/utils.js';
import { ExecutionMapPanel } from './ExecutionMapPanel.js';

interface WorkerLogPanelProps {
  entries: readonly WorkerLogEntry[];
  onClose: () => void;
  sessionId?: number | null;
  kind?: 'coder' | 'company';
  /**
   * When true, drops the panel's own header chrome (border-l + sticky
   * header) because the host already provides one (e.g. `PanelChrome`
   * inside the right-rail). The internal toolbar (search, filter,
   * autoscroll) is preserved either way.
   */
  embedded?: boolean;
}

/** Tailwind utility classes for each category badge. Picked for legibility on
 *  both light and dark themes; tweak in concert with the chat surface. */
const CATEGORY_COLORS: Record<WorkerLogEntry['category'], string> = {
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

const ALL_CATEGORIES: readonly WorkerLogEntry['category'][] = [
  'route',
  'pool',
  'worker',
  'runner',
  'tool',
  'quality',
  'provider',
  'lifecycle',
  'message',
  'other',
];

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function WorkerLogPanel({ entries, onClose, sessionId, kind = 'coder', embedded }: WorkerLogPanelProps) {
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
      return (
        e.event.toLowerCase().includes(s) ||
        e.message.toLowerCase().includes(s)
      );
    });
  }, [entries, search, filterCats]);

  // Auto-scroll to the bottom whenever new entries arrive AND the user
  // hasn't disabled it. We measure scrollHeight inside an effect rather
  // than on every render to avoid forcing a layout pass.
  useEffect(() => {
    if (!autoScroll) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, autoScroll]);

  const toggleCategory = (cat: WorkerLogEntry['category']) => {
    setFilterCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col bg-card text-card-foreground',
        // The host (`PanelChrome`) draws its own border-left + chrome when
        // embedded. Standalone (legacy 440px column inside AgentChat) keeps
        // the visual divider so the panel reads as separate from the chat.
        !embedded && 'border-l border-border',
      )}
    >
      {!embedded && (
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Worker Log
          </span>
          <span className="text-[10px] text-muted-foreground">
            {entries.length} event{entries.length === 1 ? '' : 's'}
          </span>
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
              auto-scroll
            </label>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 hover:bg-muted"
              aria-label="Close worker log"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>
      )}
      {embedded && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 shrink-0">
          <span className="text-[10px] text-muted-foreground">
            {entries.length} event{entries.length === 1 ? '' : 's'}
          </span>
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
              auto
            </label>
          </div>
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
          filtered.map((entry, idx) => {
            const key = `${entry.ts}-${entry.event}-${idx}`;
            const expanded = expandedKeys.has(key);
            const headline =
              entry.event === 'worker_log' ? entry.message : entry.event;
            return (
              <div
                key={key}
                className="border-b border-border/50 px-2 py-1 hover:bg-muted/30"
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(key)}
                  className="flex w-full items-start gap-1.5 text-left"
                >
                  {expanded ? (
                    <ChevronDown className="mt-0.5 h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="mt-0.5 h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-muted-foreground">{formatTime(entry.ts)}</span>
                  <span
                    className={cn(
                      'rounded px-1 font-mono text-[9px]',
                      CATEGORY_COLORS[entry.category],
                    )}
                  >
                    {entry.category}
                  </span>
                  <span className={cn('flex-1 truncate', LEVEL_TEXT[entry.level])}>
                    {headline}
                  </span>
                </button>
                {expanded && (
                  <pre className="ml-4 mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-1.5 text-[10px]">
                    {JSON.stringify(entry.data, null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
      )}
    </div>
  );
}

async function exportWorkerLogs(
  entries: readonly WorkerLogEntry[],
  sessionId: number | null,
  kind: 'coder' | 'company',
): Promise<void> {
  const backend = sessionId != null ? await fetchRuntimeLogs(kind, sessionId) : null;
  const jsonl = backend?.jsonl ?? entries.map((entry) => JSON.stringify(entry)).join('\n');
  const summary = backend?.summary ?? buildExportSummary(entries);
  downloadText(`worker-log-${Date.now()}.jsonl`, jsonl, 'application/x-ndjson');
  downloadText(`worker-log-summary-${Date.now()}.json`, JSON.stringify(summary, null, 2), 'application/json');
}

async function fetchRuntimeLogs(
  kind: 'coder' | 'company',
  sessionId: number,
): Promise<{ jsonl: string; summary: unknown } | null> {
  try {
    const base = `/api/${kind}/sessions/${sessionId}`;
    const [jsonlRes, summaryRes] = await Promise.all([
      fetch(`${base}/events.jsonl`),
      fetch(`${base}/events-summary`),
    ]);
    if (!jsonlRes.ok || !summaryRes.ok) return null;
    return { jsonl: await jsonlRes.text(), summary: await summaryRes.json() };
  } catch {
    return null;
  }
}

function buildExportSummary(entries: readonly WorkerLogEntry[]): Record<string, unknown> {
  const operations = new Map<string, WorkerLogEntry>();
  const agents = new Map<string, WorkerLogEntry>();
  for (const entry of entries) {
    const data = entry.data && typeof entry.data === 'object' ? entry.data as Record<string, unknown> : {};
    if (String(data.opId ?? '')) operations.set(String(data.opId), entry);
    if (data.groupId != null && data.agentIndex != null) {
      agents.set(`${String(data.groupId)}:${String(data.agentIndex)}`, entry);
    }
  }
  return {
    eventCount: entries.length,
    firstTs: entries[0]?.ts ?? null,
    lastTs: entries.at(-1)?.ts ?? null,
    lastEventByOperation: Object.fromEntries(operations),
    lastEventByAgent: Object.fromEntries(agents),
    timeouts: entries.filter((e) => {
      const raw = String(JSON.stringify(e.data) ?? '');
      return raw.includes('timed_out') || raw.includes('timeout');
    }),
  };
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
