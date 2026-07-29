/**
 * A pane's chrome: the toolbar row (up / refresh / new folder / transfer,
 * breadcrumbs, column toggles) and the sortable column-header row.
 *
 * Extracted from FilePane.tsx, which crossed this repo's per-file ceiling once
 * virtualization, sorting and keyboard handling landed in it. The split is
 * along a real seam — everything here is presentational and driven entirely by
 * props, while FilePane keeps the listing state and the interaction wiring.
 */
import { useCallback, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Check, ChevronDown, ChevronUp, Columns2, Download, FolderPlus, Loader2, RefreshCw, Upload } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { COLUMNS, type ColumnId, type ColumnVisibility, type ColumnWidths } from './column-config.js';
import type { SortKey, SortState } from './pane-sort.js';
import type { FsAdapter } from './fs-adapter.js';

const ICON_BTN = 'rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40';

interface Props {
  adapter: FsAdapter;
  cwd: string | null;
  atRoot: boolean;
  loading: boolean;
  error: string | null;
  columns: ColumnVisibility;
  columnWidths: ColumnWidths;
  sort: SortState;
  onNavigate: (dir: string) => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  onTransferSelected: () => void;
  onToggleColumn: (id: ColumnId) => void;
  onColumnWidthChange: (id: ColumnId, width: number) => void;
  onSort: (key: SortKey) => void;
}

export function FilePaneHeader(props: Props) {
  const {
    adapter, cwd, atRoot, loading, error,
    columns, columnWidths, sort,
    onNavigate, onRefresh, onNewFolder, onTransferSelected,
    onToggleColumn, onColumnWidthChange, onSort,
  } = props;
  const { t } = useTranslation('ssh');
  const crumbs = cwd == null ? [] : pathCrumbs(adapter.kind, cwd);
  const transferLabel = adapter.kind === 'local' ? t('files.toRemote') : t('files.toLocal');
  const TransferIcon = adapter.kind === 'local' ? Upload : Download;

  const startColumnResize = useCallback(
    (e: MouseEvent, id: ColumnId) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = columnWidths[id];
      const oldCursor = document.body.style.cursor;
      const oldUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const onMove = (ev: globalThis.MouseEvent): void => {
        onColumnWidthChange(id, startWidth - (ev.clientX - startX));
      };
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = oldCursor;
        document.body.style.userSelect = oldUserSelect;
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [columnWidths, onColumnWidthChange],
  );

  return (
    <>
      <div className="h-8 shrink-0 border-b flex items-center gap-1 px-2">
        <span className="text-[11px] font-medium truncate max-w-[40%]" title={adapter.label}>{adapter.label}</span>
        <button type="button" aria-label={t('sftp.up')} className={ICON_BTN} disabled={cwd == null || atRoot} onClick={() => cwd != null && onNavigate(adapter.parentDir(cwd))}>
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('sftp.refresh')} className={ICON_BTN} disabled={cwd == null} onClick={onRefresh}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('sftp.newFolder')} className={ICON_BTN} disabled={cwd == null} onClick={onNewFolder}>
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={transferLabel} title={transferLabel} className={ICON_BTN} onClick={onTransferSelected}>
          <TransferIcon className="h-3.5 w-3.5" />
        </button>
        <nav className="ml-1 flex min-w-0 flex-1 items-center overflow-hidden font-mono text-[10px] text-muted-foreground" title={cwd ?? ''}>
          {crumbs.map((crumb, i) => {
            const current = cwd === crumb.path;
            return (
              <span key={`${crumb.path}:${i}`} className="flex min-w-0 items-center">
                {i > 1 && <span className="px-0.5 text-muted-foreground/60">/</span>}
                <button
                  type="button"
                  disabled={current || loading}
                  onClick={() => onNavigate(crumb.path)}
                  className={cn(
                    'min-w-0 max-w-[120px] truncate rounded px-1 py-0.5 text-left hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:text-foreground',
                    current && 'font-medium',
                  )}
                  title={crumb.path || '/'}
                >
                  {crumb.label}
                </button>
              </span>
            );
          })}
        </nav>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label={t('sftp.columnsToggle')} title={t('sftp.columnsToggle')} className={ICON_BTN}>
              <Columns2 className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-1">
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('sftp.columnsTitle')}</p>
            {COLUMNS.map((col) => (
              <button
                key={col.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={columns[col.id]}
                onClick={() => onToggleColumn(col.id)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
              >
                <span className="w-4 flex items-center justify-center">
                  {columns[col.id] && <Check className="h-3 w-3" />}
                </span>
                {t(`sftp.columns.${col.labelKey}`)}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      {error && <div className="px-2 py-1 text-[10px] text-red-400 border-b bg-red-500/10 shrink-0">{error}</div>}

      {/* Column header — mirrors the row layout so widths align. The Name
          column flexes (flex-1); the others use the same fixed widths as
          FilePaneRow. `scrollbar-gutter: stable` matches the list below so the
          two don't drift by the scrollbar's width once it appears. */}
      <div className="flex items-center gap-2 px-3 h-6 shrink-0 border-b bg-muted/40 text-[10px] font-medium uppercase tracking-wide text-muted-foreground [scrollbar-gutter:stable]">
        <span className="w-3.5 shrink-0" />
        <SortHeader sortKey="name" label={t('sftp.columns.name')} sort={sort} onSort={onSort} className="min-w-0 flex-1 justify-start" />
        {COLUMNS.map((col) => {
          if (!columns[col.id]) return null;
          const label = t(`sftp.columns.${col.labelKey}`);
          return (
            <span key={col.id} className="group/col relative shrink-0" style={{ width: columnWidths[col.id] }}>
              <SortHeader sortKey={col.id} label={label} sort={sort} onSort={onSort} className="w-full justify-end" />
              <span
                role="separator"
                aria-orientation="vertical"
                aria-label={t('sftp.resizeColumn', { column: label })}
                title={t('sftp.resizeColumn', { column: label })}
                // stopPropagation is load-bearing: without it every resize drag
                // would also fire the header's sort click.
                onMouseDown={(e) => startColumnResize(e, col.id)}
                onClick={(e) => e.stopPropagation()}
                className="absolute -left-1 top-0 h-full w-2 cursor-col-resize rounded-sm hover:bg-primary/30 group-hover/col:bg-border"
              />
            </span>
          );
        })}
      </div>
    </>
  );
}

/**
 * A clickable column header. Bi-state: clicking the active column flips
 * direction, clicking another switches to it ascending. `aria-sort` carries the
 * state for screen readers, the chevron for everyone else.
 */
function SortHeader({
  sortKey, label, sort, onSort, className,
}: {
  sortKey: SortKey;
  label: string;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Chevron = sort.dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      title={label}
      className={cn(
        'flex items-center gap-0.5 overflow-hidden px-1 uppercase tracking-wide hover:text-foreground',
        active && 'text-foreground',
        className,
      )}
    >
      <span className="truncate whitespace-nowrap">{label}</span>
      {active && <Chevron className="h-2.5 w-2.5 shrink-0" />}
    </button>
  );
}

/** Breadcrumb segments. Local paths are project-relative, remote are absolute posix. */
function pathCrumbs(kind: FsAdapter['kind'], cwd: string): Array<{ label: string; path: string }> {
  if (kind === 'local') {
    const parts = cwd.split('/').filter(Boolean);
    const crumbs = [{ label: '/', path: '' }];
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      crumbs.push({ label: part, path });
    }
    return crumbs;
  }

  const normalized = cwd.startsWith('/') ? cwd : `/${cwd}`;
  const parts = normalized.split('/').filter(Boolean);
  const crumbs = [{ label: '/', path: '/' }];
  let path = '';
  for (const part of parts) {
    path = `${path}/${part}`;
    crumbs.push({ label: part, path });
  }
  return crumbs;
}
