import { useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import type { SnapshotFileSummary } from './types.js';

interface Props {
  files: SnapshotFileSummary[];
  selectedBaselineId: number | null;
  onSelect: (baselineId: number) => void;
  showClosed: boolean;
  onToggleShowClosed: (v: boolean) => void;
  /** When true, render the project name as a small label above the
   *  file path. Used by the company-scope panel when more than one
   *  project has snapshots in the same session. */
  showProjectLabel?: boolean;
}

function statusKind(f: SnapshotFileSummary): 'A' | 'M' | 'D' {
  // existedBefore = false → A (added)
  // pendingHunks all remove → D (deleted) — heuristic when remainder is all-remove
  // otherwise → M
  if (!f.existedBefore) return 'A';
  if (f.removedLines > 0 && f.addedLines === 0 && f.pendingHunks > 0) return 'D';
  return 'M';
}

const STATUS_STYLES: Record<'A' | 'M' | 'D', string> = {
  A: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  M: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  D: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

export function SnapshotFileList({
  files,
  selectedBaselineId,
  onSelect,
  showClosed,
  onToggleShowClosed,
  showProjectLabel,
}: Props) {
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? files.filter((x) => x.filePath.toLowerCase().includes(f)) : files;
  }, [files, filter]);
  const active = filtered.filter((f) => f.status === 'active');
  const closed = filtered.filter((f) => f.status !== 'active');

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2 border-b">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files…"
          className="w-full px-2 py-1.5 text-xs bg-background border rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {active.length === 0 && (
          <div className="text-xs text-muted-foreground italic px-3 py-6 text-center">
            No active snapshots yet.
            <br />
            Files altered by the agent during this session will appear here.
          </div>
        )}
        {active.map((f) => {
          const kind = statusKind(f);
          return (
            <button
              key={f.baselineId}
              type="button"
              onClick={() => onSelect(f.baselineId)}
              className={cn(
                'w-full text-left px-2.5 py-2 border-b flex items-center gap-2 text-xs hover:bg-muted/50 transition-colors',
                selectedBaselineId === f.baselineId && 'bg-muted',
              )}
            >
              <Badge variant="outline" className={cn('font-mono w-6 justify-center px-1 py-0', STATUS_STYLES[kind])}>
                {kind}
              </Badge>
              <span className="flex-1 min-w-0 flex flex-col">
                {showProjectLabel && f.projectName && (
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground truncate">
                    {f.projectName}
                  </span>
                )}
                <span className="truncate font-mono">{f.filePath}</span>
              </span>
              {f.oversized ? (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">big</span>
              ) : f.pendingHunks > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary/15 text-primary text-[10px] font-medium">
                  {f.pendingHunks}
                </span>
              ) : (
                <span className="text-[10px] text-emerald-600">ok</span>
              )}
            </button>
          );
        })}
        {closed.length > 0 && (
          <button
            type="button"
            onClick={() => onToggleShowClosed(!showClosed)}
            className="w-full text-left px-2.5 py-2 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-muted/30"
          >
            {showClosed ? 'Hide' : 'Show'} closed ({closed.length})
          </button>
        )}
        {showClosed &&
          closed.map((f) => {
            const kind = statusKind(f);
            return (
              <button
                key={f.baselineId}
                type="button"
                onClick={() => onSelect(f.baselineId)}
                className={cn(
                  'w-full text-left px-2.5 py-2 border-b flex items-center gap-2 text-xs opacity-60 hover:opacity-100 hover:bg-muted/50',
                  selectedBaselineId === f.baselineId && 'bg-muted opacity-100',
                )}
              >
                <Badge variant="outline" className={cn('font-mono w-6 justify-center px-1 py-0', STATUS_STYLES[kind])}>
                  {kind}
                </Badge>
                <span className="flex-1 min-w-0 flex flex-col">
                  {showProjectLabel && f.projectName && (
                    <span className="text-[9px] uppercase tracking-wide text-muted-foreground truncate">
                      {f.projectName}
                    </span>
                  )}
                  <span className="truncate font-mono line-through">{f.filePath}</span>
                </span>
                <span className="text-[10px] uppercase tracking-wide">
                  {f.status === 'closed_kept' ? 'kept' : 'reverted'}
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}
