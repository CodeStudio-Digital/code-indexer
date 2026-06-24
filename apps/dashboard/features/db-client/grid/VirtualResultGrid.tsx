/**
 * Virtualized read-only results grid (@tanstack/react-virtual) — renders only
 * the visible rows so 10k+ result sets stay smooth. Click a header to sort,
 * drag its right edge to resize, click a cell to open the value viewer, and
 * export/copy from the toolbar. Mirrors the ProblemsPanel virtualizer pattern.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown, Download, Copy } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { copyText } from '../../../lib/clipboard.js';
import { downloadBlob } from '../../api-client/download.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../../../components/ui/dropdown-menu.js';
import { columnNames, cellText } from './grid-utils.js';
import { CellValuePanel } from './CellValuePanel.js';
import { toCsv, toJson, toInsertSql, cellToCopy } from './grid-export.js';
import type { DbQueryResult } from '../types.js';

const ROW_H = 24;
const ROWNUM_W = 52;
const DEFAULT_COL_W = 168;

type SortState = { col: string; dir: 'asc' | 'desc' } | null;

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export function VirtualResultGrid({
  result,
  error,
  tableName,
}: {
  result: DbQueryResult | null;
  error?: string | null;
  tableName?: string;
}) {
  const { t } = useTranslation('dbClient');
  const [sort, setSort] = useState<SortState>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [cellView, setCellView] = useState<{ col: string; value: unknown } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const columns = result ? columnNames(result) : [];
  const rows = useMemo(() => {
    if (!result) return [];
    if (!sort) return result.rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...result.rows].sort((a, b) => cmp(a[sort.col], b[sort.col]) * dir);
  }, [result, sort]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 16,
  });

  const colW = (c: string): number => widths[c] ?? DEFAULT_COL_W;
  const totalW = ROWNUM_W + columns.reduce((w, c) => w + colW(c), 0);

  if (error) {
    return <div className="m-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-400">{error}</div>;
  }
  if (!result) return null;
  if (columns.length === 0 || result.rows.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {result.command ? `${result.command} · ${result.rowCount} ${t('query.affected')}` : t('query.empty')}
      </div>
    );
  }

  function toggleSort(col: string): void {
    setSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null));
  }

  function startResize(col: string, e: React.MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colW(col);
    const onMove = (ev: MouseEvent): void => setWidths((w) => ({ ...w, [col]: Math.max(60, startW + ev.clientX - startX) }));
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  async function exportAs(kind: 'csv' | 'json' | 'sql' | 'copy'): Promise<void> {
    const base = tableName || 'result';
    if (kind === 'csv') downloadBlob(`${base}.csv`, new Blob([toCsv(columns, rows)], { type: 'text/csv' }));
    else if (kind === 'json') downloadBlob(`${base}.json`, new Blob([toJson(columns, rows)], { type: 'application/json' }));
    else if (kind === 'sql') downloadBlob(`${base}.sql`, new Blob([toInsertSql(base, columns, rows)], { type: 'text/plain' }));
    else if (await copyText(toCsv(columns, rows))) toast.success(t('grid.copied'));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-b px-2 py-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" title={t('grid.export')}>
              <Download className="h-3.5 w-3.5" />
              {t('grid.export')}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-xs">
            <DropdownMenuItem onClick={() => void exportAs('csv')}>{'CSV'}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportAs('json')}>{'JSON'}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportAs('sql')}>{'SQL (INSERT)'}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportAs('copy')}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              {t('grid.copyCsv')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto text-xs">
        <div style={{ width: totalW, position: 'relative' }}>
          {/* Sticky header */}
          <div className="sticky top-0 z-10 flex bg-card" style={{ width: totalW }}>
            <div className="shrink-0 border-b border-r px-2 py-1 text-right text-muted-foreground/50" style={{ width: ROWNUM_W }}>
              #
            </div>
            {columns.map((c) => (
              <div
                key={c}
                className="group/h relative flex shrink-0 cursor-pointer items-center gap-1 border-b border-r px-2 py-1 font-medium text-muted-foreground hover:bg-muted/40"
                style={{ width: colW(c) }}
                onClick={() => toggleSort(c)}
                title={c}
              >
                <span className="min-w-0 flex-1 truncate">{c}</span>
                {sort?.col === c && (sort.dir === 'asc' ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />)}
                <span
                  className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/40"
                  onMouseDown={(e) => startResize(c, e)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            ))}
          </div>

          {/* Virtualized body */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              return (
                <div
                  key={v.index}
                  className="absolute left-0 flex hover:bg-muted/30"
                  style={{ top: 0, transform: `translateY(${v.start}px)`, height: v.size, width: totalW }}
                >
                  <div className="shrink-0 border-b border-r px-2 py-0.5 text-right text-muted-foreground/40 tabular-nums" style={{ width: ROWNUM_W }}>
                    {v.index + 1}
                  </div>
                  {columns.map((c) => {
                    const value = row[c];
                    const isNull = value === null;
                    return (
                      <div
                        key={c}
                        className={cn('shrink-0 cursor-text truncate border-b border-r px-2 py-0.5 font-mono', isNull && 'italic text-muted-foreground/50')}
                        style={{ width: colW(c) }}
                        title={cellText(value)}
                        onClick={() => setCellView({ col: c, value })}
                      >
                        {cellText(value)}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {cellView && <CellValuePanel open column={cellView.col} value={cellView.value} onClose={() => setCellView(null)} />}
    </div>
  );
}

export { cellToCopy };
