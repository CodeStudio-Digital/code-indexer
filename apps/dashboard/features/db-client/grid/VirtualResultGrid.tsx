/**
 * The single results grid (@tanstack/react-virtual) — used everywhere: the query
 * console (read-only) and the table-data tab (editable when the table has a PK).
 * Only the visible rows render so 10k+ result sets stay smooth.
 *
 *   - Click a header to sort (server-side via `onSort`, else client-side).
 *   - Drag a header's right edge to resize; double-click it to auto-fit.
 *   - READ-ONLY cell: click → value viewer. EDITABLE cell: click → inline edit,
 *     double-click → value viewer. Arrows/Tab/Enter move the cursor, so a row
 *     can be filled without touching the mouse.
 *   - Edited cells amber, new rows green, deleted struck-through; all go through
 *     the `useGridEdits` changeset.
 *   - The row-number column is sticky, so wide tables keep their anchor while
 *     scrolling sideways.
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown, Download, Copy, Trash2, Undo2, Pencil, Link2 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { copyText } from '../../../lib/clipboard.js';
import { downloadBlob } from '../../api-client/download.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../../../components/ui/dropdown-menu.js';
import { columnNames, cellText, isBinaryValue } from './grid-utils.js';
import { CellValuePanel } from './CellValuePanel.js';
import { RowEditorDialog } from './RowEditorDialog.js';
import { GridBodyCell, type CellCommitMove } from './GridBodyCell.js';
import { editorSpecForColumn, type ColumnEditorSpec } from './column-editor.js';
import { toCsv, toJson, toInsertSql, cellToCopy } from './grid-export.js';
import { rowKeyOf, type GridEdits } from './use-grid-edits.js';
import type { DbColumn, DbQueryResult, DbTableSort } from '../types.js';

const ROW_H = 24;
const ROWNUM_W = 52;
const DEFAULT_COL_W = 168;
const MIN_COL_W = 60;
const MAX_AUTOFIT_W = 520;

type SortState = { col: string; dir: 'asc' | 'desc' } | null;
type Cursor = { row: number; col: number };

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a).localeCompare(String(b));
}

const TEXT_SPEC: ColumnEditorSpec = { kind: 'text', enumValues: [] };

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
  /** Introspected relational metadata; enables typed editing + the row editor. */
  columnMeta?: DbColumn[];
}) {
  const { t } = useTranslation('dbClient');
  const [internalSort, setInternalSort] = useState<SortState>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [cellView, setCellView] = useState<{ col: string; value: unknown } | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [editing, setEditing] = useState(false);
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
  const metaByName = useMemo(() => new Map((columnMeta ?? []).map((column) => [column.name, column])), [columnMeta]);
  const editorColumns = useMemo<DbColumn[]>(
    () => columns.map((name) => metaByName.get(name) ?? {
      name,
      dataType: 'text',
      nullable: true,
      isPrimaryKey: pkCols?.includes(name) ?? false,
    }),
    [columns, metaByName, pkCols],
  );
  // One spec per visible column — the inline editor coerces through it.
  const specs = useMemo(
    () => columns.map((name) => {
      const meta = metaByName.get(name);
      return meta ? editorSpecForColumn(meta) : TEXT_SPEC;
    }),
    [columns, metaByName],
  );

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

  const colW = useCallback((c: string): number => widths[c] ?? DEFAULT_COL_W, [widths]);
  const rowActionCount = (onRelatedRows ? 1 : 0) + (editable ? 2 : onRowOpen ? 1 : 0);
  const rowNumW = Math.max(ROWNUM_W, 28 + rowActionCount * 20);
  const totalW = rowNumW + columns.reduce((w, c) => w + colW(c), 0);
  const sortCol = onSort ? sort?.column : internalSort?.col;
  const sortDir = onSort ? sort?.dir : internalSort?.dir;

  /** Move the cursor, wrapping across row boundaries, and scroll it into view. */
  const moveCursor = useCallback((from: Cursor, dRow: number, dCol: number): Cursor | null => {
    let { row, col } = { row: from.row + dRow, col: from.col + dCol };
    if (col < 0) {
      col = columns.length - 1;
      row -= 1;
    } else if (col >= columns.length) {
      col = 0;
      row += 1;
    }
    if (row < 0 || row >= total || col < 0) return null;
    virtualizer.scrollToIndex(row, { align: 'auto' });
    return { row, col };
  }, [columns.length, total, virtualizer]);

  const cellIsEditable = useCallback((rowIndex: number, colIndex: number): boolean => {
    if (!editable) return false;
    const name = columns[colIndex];
    if (rowIndex >= baseRows.length) return !isBinaryValue(newRows[rowIndex - baseRows.length]?.values[name]);
    const row = baseRows[rowIndex];
    if (!row) return false;
    if (edits!.deleted.has(rowKeyOf(row, pkCols!))) return false;
    return !isBinaryValue(row[name]);
  }, [baseRows, columns, editable, edits, newRows, pkCols]);

  /** Apply a committed cell value, then park the cursor where the key asked. */
  const commitCell = useCallback((rowIndex: number, colIndex: number, value: unknown, move: CellCommitMove) => {
    const name = columns[colIndex];
    // The row can be gone: the unmount flush in GridBodyCell fires while a page
    // reload is swapping `result`, and a new row can be removed under the cursor.
    const newRow = rowIndex >= baseRows.length ? newRows[rowIndex - baseRows.length] : null;
    const row = newRow ? null : baseRows[rowIndex];
    if (!newRow && !row) {
      setEditing(false);
      return;
    }
    if (newRow) edits!.setNewCell(newRow.tempId, name, value);
    else edits!.setCell(rowKeyOf(row!, pkCols!), name, value, row![name]);
    if (move === 'none') {
      setEditing(false);
      return;
    }
    const next = moveCursor({ row: rowIndex, col: colIndex }, move === 'down' ? 1 : 0, move === 'right' ? 1 : move === 'left' ? -1 : 0);
    if (!next) {
      setEditing(false);
      return;
    }
    setCursor(next);
    setEditing(cellIsEditable(next.row, next.col));
  }, [baseRows, cellIsEditable, columns, edits, moveCursor, newRows, pkCols]);

  const onGridKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing || !cursor) return;
    const step = (dRow: number, dCol: number): void => {
      event.preventDefault();
      const next = moveCursor(cursor, dRow, dCol);
      if (next) setCursor(next);
    };
    switch (event.key) {
      case 'ArrowDown': return step(1, 0);
      case 'ArrowUp': return step(-1, 0);
      case 'ArrowRight': return step(0, 1);
      case 'ArrowLeft': return step(0, -1);
      case 'Tab': return step(0, event.shiftKey ? -1 : 1);
      case 'Enter':
        event.preventDefault();
        if (cellIsEditable(cursor.row, cursor.col)) setEditing(true);
        return;
      case 'Escape':
        // Release the cursor so Tab leaves the grid again (keyboard users).
        setCursor(null);
        return;
      case 'c':
      case 'C': {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const name = columns[cursor.col];
        const value = cursor.row >= baseRows.length
          ? newRows[cursor.row - baseRows.length]?.values[name]
          : baseRows[cursor.row]?.[name];
        void copyText(cellToCopy(value));
        return;
      }
      default:
    }
  }, [baseRows, cellIsEditable, columns, cursor, editing, moveCursor, newRows]);

  const header = useCallback((col: string): void => {
    if (onSort) onSort(col);
    else setInternalSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null));
  }, [onSort]);

  function startResize(col: string, e: React.MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colW(col);
    const onMove = (ev: MouseEvent): void => setWidths((w) => ({ ...w, [col]: Math.max(MIN_COL_W, startW + ev.clientX - startX) }));
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /** Double-click the resize handle → widen to the longest value on screen. */
  function autoFit(col: string): void {
    let longest = col.length;
    for (const row of baseRows) longest = Math.max(longest, cellText(row[col]).length);
    setWidths((w) => ({ ...w, [col]: Math.min(MAX_AUTOFIT_W, Math.max(MIN_COL_W, longest * 7 + 24)) }));
  }

  async function exportAs(kind: 'csv' | 'json' | 'sql' | 'copy'): Promise<void> {
    const base = tableName || 'result';
    if (kind === 'csv') downloadBlob(`${base}.csv`, new Blob([toCsv(columns, baseRows)], { type: 'text/csv' }));
    else if (kind === 'json') downloadBlob(`${base}.json`, new Blob([toJson(columns, baseRows)], { type: 'application/json' }));
    else if (kind === 'sql') downloadBlob(`${base}.sql`, new Blob([toInsertSql(base, columns, baseRows)], { type: 'text/plain' }));
    else if (await copyText(toCsv(columns, baseRows))) toast.success(t('grid.copied'));
  }

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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-0.5">
        <span className="tabular-nums text-[11px] text-muted-foreground">
          {t('grid.rowsShown', { n: baseRows.length })}
        </span>
        {result.truncated && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-400" title={t('grid.truncatedHint')}>
            {t('grid.truncated')}
          </span>
        )}
        <div className="flex-1" />
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

      <div
        ref={scrollRef}
        data-text-selectable
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        className="flex-1 overflow-auto text-xs outline-none"
      >
        <div style={{ width: totalW, position: 'relative' }}>
          {/* Sticky header */}
          <div className="sticky top-0 z-20 flex bg-card" style={{ width: totalW }}>
            <div
              className="sticky left-0 z-10 shrink-0 border-b border-r bg-card px-2 py-1 text-right text-muted-foreground/50"
              style={{ width: rowNumW }}
            >
              #
            </div>
            {columns.map((c) => (
              <div
                key={c}
                className="group/h relative flex shrink-0 cursor-pointer items-center gap-1 border-b border-r px-2 py-1 font-medium text-muted-foreground hover:bg-muted/40"
                style={{ width: colW(c) }}
                onClick={() => header(c)}
                title={metaByName.get(c)?.dataType ? `${c} · ${metaByName.get(c)!.dataType}` : c}
              >
                <span className="min-w-0 flex-1 truncate">{c}</span>
                {pkCols?.includes(c) && <span className="shrink-0 text-amber-400">★</span>}
                {sortCol === c && (sortDir === 'asc' ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />)}
                <span
                  className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/40"
                  onMouseDown={(e) => startResize(c, e)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => { e.stopPropagation(); autoFit(c); }}
                />
              </div>
            ))}
          </div>

          {/* Virtualized body (existing rows then new rows) */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const isNew = v.index >= baseRows.length;
              // Positioned with `top`, not `transform`: a transformed ancestor
              // creates a containing block that breaks the sticky row-number
              // column. Rows are absolutely positioned, so this stays cheap.
              const style: React.CSSProperties = {
                top: v.start,
                height: v.size,
                width: totalW,
              };

              if (isNew) {
                const nr = newRows[v.index - baseRows.length];
                return (
                  <div key={nr.tempId} className="group absolute left-0 flex bg-emerald-500/5" style={style}>
                    <div className="sticky left-0 z-10 flex shrink-0 items-center justify-end gap-1 overflow-hidden border-b border-r bg-card px-1" style={{ width: rowNumW }}>
                      <span className="mr-auto min-w-4 text-center text-emerald-500">+</span>
                      <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-primary" title={t('edit.editRow')} onClick={() => setRowEdit({ kind: 'new', tempId: nr.tempId, row: nr.values })}>
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-red-400" title={t('edit.deleteRow')} onClick={() => edits!.removeNewRow(nr.tempId)}>
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    {columns.map((c, colIndex) => (
                      <GridBodyCell
                        key={c}
                        cellId={`${nr.tempId}:${c}`}
                        value={nr.values[c] ?? null}
                        width={colW(c)}
                        spec={specs[colIndex]}
                        edited={c in nr.values}
                        unset={!(c in nr.values)}
                        selected={cursor?.row === v.index && cursor.col === colIndex}
                        editing={editing && cursor?.row === v.index && cursor.col === colIndex}
                        editable
                        onSelect={() => setCursor({ row: v.index, col: colIndex })}
                        onStartEdit={() => { setCursor({ row: v.index, col: colIndex }); setEditing(true); }}
                        onCommit={(value, move) => commitCell(v.index, colIndex, value, move)}
                        onCancel={() => setEditing(false)}
                        onNull={() => { edits!.setNewCell(nr.tempId, c, null); setEditing(false); }}
                        onView={() => setCellView({ col: c, value: nr.values[c] })}
                        nullLabel={t('edit.setNull')}
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
                  <div className="sticky left-0 z-10 flex shrink-0 items-center justify-end gap-1 overflow-hidden border-b border-r bg-card px-1 text-right text-muted-foreground tabular-nums group-hover:bg-muted/60" style={{ width: rowNumW }}>
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
                  {columns.map((c, colIndex) => {
                    const value = editable ? edits!.cellValue(rk, c, row[c]) : row[c];
                    const binary = isBinaryValue(value);
                    return (
                      <GridBodyCell
                        key={c}
                        cellId={`${rk}:${c}`}
                        value={value}
                        width={colW(c)}
                        spec={specs[colIndex]}
                        edited={editable && edits!.isEdited(rk, c)}
                        deleted={isDeleted}
                        selected={cursor?.row === v.index && cursor.col === colIndex}
                        editing={editing && cursor?.row === v.index && cursor.col === colIndex}
                        editable={editable && !isDeleted}
                        binary={binary}
                        onSelect={() => setCursor({ row: v.index, col: colIndex })}
                        onStartEdit={() => { setCursor({ row: v.index, col: colIndex }); setEditing(true); }}
                        onCommit={(next, move) => commitCell(v.index, colIndex, next, move)}
                        onCancel={() => setEditing(false)}
                        onNull={() => { edits!.setCell(rk, c, null, row[c]); setEditing(false); }}
                        onView={() => setCellView({ col: c, value })}
                        nullLabel={t('edit.setNull')}
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
              Object.entries(values).forEach(([column, value]) => edits!.setCell(rowEdit.rowKey, column, value, rowEdit.row[column]));
            }
            setRowEdit(null);
          }}
        />
      )}
    </div>
  );
});
