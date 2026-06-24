/**
 * Editable data grid (phpMyAdmin-style). Click a cell to edit it; edited cells
 * highlight amber, new rows green, deleted rows struck-through red. All edits go
 * through the `useGridEdits` changeset — nothing touches the DB until the user
 * previews + applies. Cell editing is click-to-edit (one active editor) so large
 * pages stay light.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Undo2, Ban } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { cellText } from './grid-utils.js';
import { rowKeyOf, type GridEdits, type Row } from './use-grid-edits.js';

export function EditableGrid({
  rows,
  columns,
  pkCols,
  edits,
}: {
  rows: Row[];
  columns: string[];
  pkCols: string[];
  edits: GridEdits;
}) {
  const { t } = useTranslation('dbClient');
  const [active, setActive] = useState<string | null>(null); // `${rowId}:${col}`

  return (
    <div className="min-w-full">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            <th className="w-8 border-b border-r px-1 py-1" />
            {columns.map((c) => (
              <th key={c} className="border-b border-r px-2 py-1 text-left font-medium text-muted-foreground">
                {c}
                {pkCols.includes(c) && <span className="ml-1 text-amber-400">★</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rk = rowKeyOf(row, pkCols);
            const isDeleted = edits.deleted.has(rk);
            return (
              <tr key={rk} className={cn('hover:bg-muted/30', isDeleted && 'opacity-50')}>
                <td className="border-b border-r px-1 py-0.5 text-center">
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground hover:text-red-400"
                    title={isDeleted ? t('edit.restoreRow') : t('edit.deleteRow')}
                    onClick={() => edits.toggleDelete(rk)}
                  >
                    {isDeleted ? <Undo2 className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                  </button>
                </td>
                {columns.map((col) => {
                  const value = edits.cellValue(rk, col, row[col]);
                  const cellId = `${rk}:${col}`;
                  return (
                    <Cell
                      key={col}
                      cellId={cellId}
                      value={value}
                      edited={edits.isEdited(rk, col)}
                      deleted={isDeleted}
                      active={active === cellId}
                      onActivate={() => !isDeleted && setActive(cellId)}
                      onCommit={(v) => {
                        edits.setCell(rk, col, v);
                        setActive(null);
                      }}
                      onCancel={() => setActive(null)}
                      onNull={() => {
                        edits.setCell(rk, col, null);
                        setActive(null);
                      }}
                      t={t}
                    />
                  );
                })}
              </tr>
            );
          })}

          {/* New rows (insert). */}
          {edits.newRows.map((nr) => (
            <tr key={nr.tempId} className="bg-emerald-500/5">
              <td className="border-b border-r px-1 py-0.5 text-center">
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:text-red-400"
                  title={t('edit.deleteRow')}
                  onClick={() => edits.removeNewRow(nr.tempId)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </td>
              {columns.map((col) => {
                const cellId = `${nr.tempId}:${col}`;
                return (
                  <Cell
                    key={col}
                    cellId={cellId}
                    value={nr.values[col]}
                    edited={col in nr.values}
                    deleted={false}
                    isNew
                    active={active === cellId}
                    onActivate={() => setActive(cellId)}
                    onCommit={(v) => {
                      edits.setNewCell(nr.tempId, col, v);
                      setActive(null);
                    }}
                    onCancel={() => setActive(null)}
                    onNull={() => {
                      edits.setNewCell(nr.tempId, col, null);
                      setActive(null);
                    }}
                    t={t}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        onClick={edits.addRow}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('edit.addRow')}
      </button>
    </div>
  );
}

function Cell({
  cellId,
  value,
  edited,
  deleted,
  isNew,
  active,
  onActivate,
  onCommit,
  onCancel,
  onNull,
  t,
}: {
  cellId: string;
  value: unknown;
  edited: boolean;
  deleted: boolean;
  isNew?: boolean;
  active: boolean;
  onActivate: () => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
  onNull: () => void;
  t: (k: string) => string;
}) {
  const isNull = value === null;
  const display = isNull ? '∅' : cellText(value);

  if (active) {
    return (
      <td className="border-b border-r p-0">
        <div className="flex items-center">
          <input
            autoFocus
            defaultValue={isNull ? '' : cellText(value)}
            className="min-w-0 flex-1 bg-background px-2 py-1 font-mono text-xs outline-none ring-1 ring-primary"
            onBlur={(e) => onCommit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommit((e.target as HTMLInputElement).value);
              else if (e.key === 'Escape') onCancel();
            }}
          />
          <button
            type="button"
            className="shrink-0 px-1 text-muted-foreground hover:text-amber-400"
            title={t('edit.setNull')}
            onMouseDown={(e) => {
              e.preventDefault();
              onNull();
            }}
          >
            <Ban className="h-3 w-3" />
          </button>
        </div>
      </td>
    );
  }

  return (
    <td
      data-cell={cellId}
      onClick={onActivate}
      className={cn(
        'max-w-[320px] cursor-text truncate border-b border-r px-2 py-1 font-mono',
        deleted && 'line-through',
        edited && !isNew && 'bg-amber-500/15',
        isNull && 'text-muted-foreground/50 italic',
      )}
      title={display}
    >
      {display}
    </td>
  );
}
