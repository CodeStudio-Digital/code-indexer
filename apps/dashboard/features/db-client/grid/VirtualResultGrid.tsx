/**
 * The single results grid (@tanstack/react-virtual) — used everywhere: the query
 * console (read-only) and the table-data tab (editable when the table has a PK).
 * Only the visible rows render so 10k+ result sets stay smooth.
 *
 *   - Click a header to sort (server-side via `onSort`, else client-side).
 *   - Drag a header's right edge to resize.
 *   - READ-ONLY cell: click → value viewer. EDITABLE cell: click → inline edit,
 *     double-click → value viewer. Edited cells amber, new rows green, deleted
 *     struck-through; all go through the `useGridEdits` changeset.
 *   - Export/copy from the toolbar.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown, Download, Copy, Trash2, Undo2, Ban, Pencil, Link2 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { copyText } from '../../../lib/clipboard.js';
import { downloadBlob } from '../../api-client/download.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../../../components/ui/dropdown-menu.js';
import { columnNames, cellText } from './grid-utils.js';
import { CellValuePanel } from './CellValuePanel.js';
import { RowEditorDialog } from './RowEditorDialog.js';
import { toCsv, toJson, toInsertSql, cellToCopy } from './grid-export.js';
import { rowKeyOf, type GridEdits } from './use-grid-edits.js';
import type { DbColumn, DbQueryResult, DbTableSort } from '../types.js';

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

/** A drag-to-select gesture ends with a click in Chromium. Do not turn that
 * click into an edit/view action when the user was selecting a cell value. */
function hasActiveTextSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}

export const VirtualResultGrid = memo(function VirtualResultGrid({
  result,
  error,
  tableName,
  edits,
  pkCols,
  sort,
  onSort,
  hiddenColumns,
  onRowOpen,
  onRelatedRows,
  columnMeta,
}: {
  result: DbQueryResult | null;
  error?: string | null;
  tableName?: string;
  /** Editable mode: pending-changeset state. Requires `pkCols`. */
  edits?: GridEdits;
  /** Primary-key columns — when present + non-empty, the grid is editable. */
  pkCols?: string[];
  /** Controlled (server-side) sort indicator; pair with `onSort`. */
  sort?: DbTableSort | null;
  /** Header click → server-side sort. When omitted, the grid sorts client-side. */
  onSort?: (col: string) => void;
  /** Columns to hide from display/export (the data still carries them). */
  hiddenColumns?: Set<string>;
  /** Read-only row action (document store) — pencil per row → open the full record. */
  onRowOpen?: (row: Record<string, unknown>) => void;
  /** Relational navigation — open rows connected through foreign keys. */
  onRelatedRows?: (row: Record<string, unknown>) => void;
  /** Introspected relational metadata; enables the shared typed row editor. */
  columnMeta?: DbColumn[];
}) {
  const { t } = useTranslation('dbClient');
  const [internalSort, setInternalSort] = useState<SortState>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [cellView, setCellView] = useState<{ col: string; value: unknown } | null>(null);
  const [active, setActive] = useState<string | null>(null); // `${rowId}:${col}`
  const [rowEdit, setRowEdit] = useState<
    | { kind: 'existing'; rowKey: string; row: Record<string, unknown> }
    | { kind: 'new'; tempId: string; row: Record<string, unknown> }
    | null
  >(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const editable = !!(edits && pkCols && pkCols.length > 0);
  const columns = useMemo(
    () => (result ? columnNames(result) : []).filter((column) => !hiddenColumns?.has(column)),
    [hiddenColumns, result],
  );
  const editorColumns = useMemo<DbColumn[]>(() => {
    const byName = new Map((columnMeta ?? []).map((column) => [column.name, column]));
    return columns.map((name) => byName.get(name) ?? {
      name,
      dataType: 'text',
      nullable: true,
      isPrimaryKey: pkCols?.includes(name) ?? false,
    });
  }, [columnMeta, columns, pkCols]);

  // Server-sorted when controlled; otherwise sort the page client-side.
  const baseRows = useMemo(() => {
    if (!result) return [];
    if (onSort || !internalSort) return result.rows;
    const dir = internalSort.dir === 'asc' ? 1 : -1;
    return [...result.rows].sort((a, b) => cmp(a[internalSort.col], b[internalSort.col]) * dir);
  }, [result, internalSort, onSort]);

  const newRows = editable ? edits!.newRows : [];
  const total = baseRows.length + newRows.length;

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 16,
  });

  const colW = (c: string): number => widths[c] ?? DEFAULT_COL_W;
  const rowActionCount = (onRelatedRows ? 1 : 0) + (editable ? 2 : onRowOpen ? 1 : 0);
  const rowNumW = Math.max(ROWNUM_W, 28 + rowActionCount * 20);
  const totalW = rowNumW + columns.reduce((w, c) => w + colW(c), 0);
  const sortCol = onSort ? sort?.column : internalSort?.col;
  const sortDir = onSort ? sort?.dir : internalSort?.dir;

  if (error) {
    return <div className="m-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-400">{error}</div>;
  }
  if (!result) return null;
  if (columns.length === 0 || (result.rows.length === 0 && newRows.length === 0)) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {result.command ? `${result.command} · ${result.rowCount} ${t('query.affected')}` : t('query.empty')}
      </div>
    );
  }

  function header(col: string): void {
    if (onSort) onSort(col);
    else setInternalSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null));
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
    if (kind === 'csv') downloadBlob(`${base}.csv`, new Blob([toCsv(columns, baseRows)], { type: 'text/csv' }));
    else if (kind === 'json') downloadBlob(`${base}.json`, new Blob([toJson(columns, baseRows)], { type: 'application/json' }));
    else if (kind === 'sql') downloadBlob(`${base}.sql`, new Blob([toInsertSql(base, columns, baseRows)], { type: 'text/plain' }));
    else if (await copyText(toCsv(columns, baseRows))) toast.success(t('grid.copied'));
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

      <div ref={scrollRef} data-text-selectable className="flex-1 overflow-auto text-xs">
        <div style={{ width: totalW, position: 'relative' }}>
          {/* Sticky header */}
          <div className="sticky top-0 z-10 flex bg-card" style={{ width: totalW }}>
            <div className="shrink-0 border-b border-r px-2 py-1 text-right text-muted-foreground/50" style={{ width: rowNumW }}>
              #
            </div>
            {columns.map((c) => (
              <div
                key={c}
                className="group/h relative flex shrink-0 cursor-pointer items-center gap-1 border-b border-r px-2 py-1 font-medium text-muted-foreground hover:bg-muted/40"
                style={{ width: colW(c) }}
                onClick={() => header(c)}
                title={c}
              >
                <span className="min-w-0 flex-1 truncate">{c}</span>
                {pkCols?.includes(c) && <span className="shrink-0 text-amber-400">★</span>}
                {sortCol === c && (sortDir === 'asc' ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />)}
                <span
                  className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/40"
                  onMouseDown={(e) => startResize(c, e)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            ))}
          </div>

          {/* Virtualized body (existing rows then new rows) */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const isNew = v.index >= baseRows.length;
              const style: React.CSSProperties = {
                top: 0,
                transform: `translateY(${v.start}px)`,
                height: v.size,
                width: totalW,
                contain: 'strict',
              };

              if (isNew) {
                const nr = newRows[v.index - baseRows.length];
                return (
                  <div key={nr.tempId} className="absolute left-0 flex bg-emerald-500/5" style={style}>
                    <div className="flex shrink-0 items-center justify-end gap-1 overflow-hidden border-b border-r px-1" style={{ width: rowNumW }}>
                      <span className="mr-auto min-w-4 text-center text-emerald-500">+</span>
                      <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-primary" title={t('edit.editRow')} onClick={() => setRowEdit({ kind: 'new', tempId: nr.tempId, row: nr.values })}>
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-red-400" title={t('edit.deleteRow')} onClick={() => edits!.removeNewRow(nr.tempId)}>
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    {columns.map((c) => (
                      <BodyCell
                        key={c}
                        cellId={`${nr.tempId}:${c}`}
                        value={nr.values[c]}
                        width={colW(c)}
                        edited={c in nr.values}
                        active={active === `${nr.tempId}:${c}`}
                        editable
                        onActivate={() => setActive(`${nr.tempId}:${c}`)}
                        onCommit={(val) => { edits!.setNewCell(nr.tempId, c, val); setActive(null); }}
                        onCancel={() => setActive(null)}
                        onNull={() => { edits!.setNewCell(nr.tempId, c, null); setActive(null); }}
                        onView={() => setCellView({ col: c, value: nr.values[c] })}
                        t={t}
                      />
                    ))}
                  </div>
                );
              }

              const row = baseRows[v.index];
              const rk = editable ? rowKeyOf(row, pkCols!) : String(v.index);
              const isDeleted = editable && edits!.deleted.has(rk);
              return (
                <div key={rk} className={cn('group absolute left-0 flex hover:bg-muted/30', isDeleted && 'opacity-50')} style={style}>
                  <div className="flex shrink-0 items-center justify-end gap-1 overflow-hidden border-b border-r px-1 text-right text-muted-foreground tabular-nums" style={{ width: rowNumW }}>
                    <span className="mr-auto min-w-4 text-right text-muted-foreground/60">{v.index + 1}</span>
                    {onRelatedRows && (
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                        title={t('grid.relatedRows')}
                        onClick={() => onRelatedRows(row)}
                      >
                        <Link2 className="h-3 w-3" />
                      </button>
                    )}
                    {editable ? (
                      <>
                        {!isDeleted && (
                          <button
                            type="button"
                            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                            title={t('edit.editRow')}
                            onClick={() => setRowEdit({ kind: 'existing', rowKey: rk, row })}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-red-400"
                          title={isDeleted ? t('edit.restoreRow') : t('edit.deleteRow')}
                          onClick={() => edits!.toggleDelete(rk)}
                        >
                          {isDeleted ? <Undo2 className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                        </button>
                      </>
                    ) : onRowOpen ? (
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                        title={t('docs.openRow')}
                        onClick={() => onRowOpen(row)}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                  {columns.map((c) => {
                    const value = editable ? edits!.cellValue(rk, c, row[c]) : row[c];
                    return (
                      <BodyCell
                        key={c}
                        cellId={`${rk}:${c}`}
                        value={value}
                        width={colW(c)}
                        edited={editable && edits!.isEdited(rk, c)}
                        deleted={isDeleted}
                        active={active === `${rk}:${c}`}
                        editable={editable && !isDeleted}
                        onActivate={() => editable && !isDeleted && setActive(`${rk}:${c}`)}
                        onCommit={(val) => { edits!.setCell(rk, c, val); setActive(null); }}
                        onCancel={() => setActive(null)}
                        onNull={() => { edits!.setCell(rk, c, null); setActive(null); }}
                        onView={() => setCellView({ col: c, value })}
                        t={t}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {cellView && <CellValuePanel open column={cellView.col} value={cellView.value} onClose={() => setCellView(null)} />}
      {rowEdit && editable && (
        <RowEditorDialog
          open
          columns={editorColumns}
          row={rowEdit.row}
          isNew={rowEdit.kind === 'new'}
          onClose={() => setRowEdit(null)}
          onSave={(values) => {
            if (rowEdit.kind === 'new') {
              Object.entries(values).forEach(([column, value]) => edits!.setNewCell(rowEdit.tempId, column, value));
            } else {
              Object.entries(values).forEach(([column, value]) => {
                if (!sameGridValue(value, rowEdit.row[column])) edits!.setCell(rowEdit.rowKey, column, value);
              });
            }
            setRowEdit(null);
          }}
        />
      )}
    </div>
  );
});

function sameGridValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/** One body cell — read-only (click → view) or editable (click → inline edit, dbl-click → view). */
interface BodyCellProps {
  cellId: string;
  value: unknown;
  width: number;
  edited?: boolean;
  deleted?: boolean;
  active: boolean;
  editable?: boolean;
  onActivate: () => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
  onNull: () => void;
  onView: () => void;
  t: (k: string) => string;
}

function BodyCellImpl({
  cellId, value, width, edited, deleted, active, editable, onActivate, onCommit, onCancel, onNull, onView, t,
}: BodyCellProps) {
  const isNull = value == null; // treat undefined (unset new-row cell) like null
  const text = useMemo(() => (isNull ? '' : cellText(value)), [isNull, value]);
  const initial = text;
  // Only record an edit when the text actually changed.
  const commit = (raw: string): void => (raw === initial ? onCancel() : onCommit(raw));
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Commit the in-flight value if the cell is torn down while editing (the
  // virtualizer unmounts rows scrolled out of view, which wouldn't fire blur).
  useEffect(() => {
    if (!active) return;
    return () => {
      const el = inputRef.current;
      if (el && el.value !== initial) onCommit(el.value);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (active) {
    return (
      <div className="flex shrink-0 items-center border-b border-r p-0" style={{ width }} data-cell={cellId}>
        <input
          ref={inputRef}
          autoFocus
          defaultValue={initial}
          className="min-w-0 flex-1 bg-background px-2 py-0.5 font-mono text-xs outline-none ring-1 ring-primary"
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
            else if (e.key === 'Escape') onCancel();
          }}
        />
        <button type="button" className="shrink-0 px-1 text-muted-foreground hover:text-amber-400" title={t('edit.setNull')} onMouseDown={(e) => { e.preventDefault(); onNull(); }}>
          <Ban className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-cell={cellId}
      className={cn(
        'shrink-0 cursor-text truncate border-b border-r px-2 py-0.5 font-mono',
        deleted && 'line-through',
        edited && 'bg-amber-500/15',
        isNull && 'italic text-muted-foreground/50',
      )}
      style={{ width, contentVisibility: 'auto', containIntrinsicSize: `${width}px ${ROW_H}px` }}
      title={text}
      onClick={() => {
        if (hasActiveTextSelection()) return;
        if (editable) onActivate();
        else onView();
      }}
      onDoubleClick={editable ? onView : undefined}
    >
      {isNull ? '∅' : text}
    </div>
  );
}

const BodyCell = memo(BodyCellImpl, (previous, next) => (
  previous.cellId === next.cellId
  && Object.is(previous.value, next.value)
  && previous.width === next.width
  && previous.edited === next.edited
  && previous.deleted === next.deleted
  && previous.active === next.active
  && previous.editable === next.editable
  && previous.t === next.t
));

export { cellToCopy };
