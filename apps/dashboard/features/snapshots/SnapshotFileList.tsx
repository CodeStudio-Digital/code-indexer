import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import type { SnapshotFileSummary } from './types.js';

interface Props {
  files: SnapshotFileSummary[];
  selectedBaselineId: string | null;
  onSelect: (baselineId: string) => void;
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

function pathParts(filePath: string): { name: string; directory: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const separator = normalized.lastIndexOf('/');
  if (separator < 0) return { name: normalized, directory: '' };
  return { name: normalized.slice(separator + 1), directory: normalized.slice(0, separator) };
}

export function SnapshotFileList({
  files,
  selectedBaselineId,
  onSelect,
  showClosed,
  onToggleShowClosed,
  showProjectLabel,
}: Props) {
  const { t } = useTranslation('projects');
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? files.filter((x) => x.filePath.toLowerCase().includes(f)) : files;
  }, [files, filter]);
  const active = filtered.filter((f) => f.status === 'active');
  const closed = filtered.filter((f) => f.status !== 'active');

  const renderFile = (f: SnapshotFileSummary, isClosed = false) => {
    const kind = statusKind(f);
    const { name, directory } = pathParts(f.filePath);
    const location = showProjectLabel && f.projectName
      ? [f.projectName, directory].filter(Boolean).join(' · ')
      : directory;

    return (
      <button
        key={f.baselineId}
        type="button"
        onClick={() => onSelect(f.baselineId)}
        title={f.filePath}
        className={cn(
          'w-full min-h-11 border-b px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50',
          'flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          isClosed && 'opacity-60 hover:opacity-100',
          selectedBaselineId === f.baselineId && 'bg-muted opacity-100',
        )}
      >
        <Badge
          variant="outline"
          className={cn('h-5 w-5 shrink-0 justify-center rounded px-0 py-0 font-mono text-[10px]', STATUS_STYLES[kind])}
        >
          {kind}
        </Badge>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('min-w-0 flex-1 truncate font-mono font-medium', isClosed && 'line-through')}>
              {name}
            </span>
            {isClosed ? (
              <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground">
                {f.status === 'closed_kept' ? t('snapshotFiles.kept') : t('snapshotFiles.reverted')}
              </span>
            ) : f.oversized ? (
              <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground">
                {t('snapshotFiles.large')}
              </span>
            ) : f.pendingHunks > 0 ? (
              <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1 text-[9px] font-medium text-primary">
                {f.pendingHunks}
              </span>
            ) : (
              <span className="shrink-0 text-[9px] text-emerald-600">{t('snapshotFiles.resolved')}</span>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{location || t('snapshotFiles.root')}</span>
            {!f.oversized && (
              <span className="shrink-0 font-mono tabular-nums">
                <span className="text-emerald-600">+{f.addedLines}</span>{' '}
                <span className="text-rose-600">-{f.removedLines}</span>
              </span>
            )}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="border-b p-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('snapshotFiles.filter')}
            aria-label={t('snapshotFiles.filter')}
            className="h-7 w-full rounded-md border bg-background pl-7 pr-7 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter('')}
              className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('snapshotFiles.clearFilter')}
              title={t('snapshotFiles.clearFilter')}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 && filter.trim() && (
          <div className="px-3 py-6 text-center text-xs italic text-muted-foreground">
            {t('snapshotFiles.noMatch')}
          </div>
        )}
        {filtered.length === 0 && !filter.trim() && (
          <div className="px-3 py-6 text-center text-xs italic text-muted-foreground">
            {t('snapshotFiles.empty')}
            <br />
            {t('snapshotFiles.emptyHint')}
          </div>
        )}
        {filtered.length > 0 && active.length === 0 && !showClosed && (
          <div className="text-xs text-muted-foreground italic px-3 py-6 text-center">
            {t('snapshotFiles.empty')}
            <br />
            {t('snapshotFiles.emptyHint')}
          </div>
        )}
        {active.map((f) => renderFile(f))}
        {showClosed && closed.map((f) => renderFile(f, true))}
      </div>
      {closed.length > 0 && (
        <button
          type="button"
          onClick={() => onToggleShowClosed(!showClosed)}
          className="shrink-0 border-t px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-muted/30 hover:text-foreground"
        >
          {showClosed
            ? t('snapshotFiles.hideClosed', { count: closed.length })
            : t('snapshotFiles.showClosed', { count: closed.length })}
        </button>
      )}
    </div>
  );
}
