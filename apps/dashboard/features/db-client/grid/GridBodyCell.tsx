/**
 * One body cell of the result grid.
 *
 * Two states: SELECTED (keyboard cursor, click-to-view) and EDITING (an input).
 * The committed value is coerced through the column's editor spec, so a numeric
 * column receives a number and a boolean column a boolean instead of the raw
 * input string — the previous behaviour sent every edit as text, which the
 * stricter engines (Postgres/Oracle) reject outright on a typed column.
 *
 * Binary cells are never editable inline: a hex preview can't round-trip to
 * bytes, so clicking one opens the value viewer instead of an input.
 */
import { memo, useEffect, useMemo, useRef } from 'react';
import { Ban } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { cellText } from './grid-utils.js';
import { coerceCellInput, type ColumnEditorSpec } from './column-editor.js';

/** Where a commit sends the cursor next. */
export type CellCommitMove = 'none' | 'down' | 'right' | 'left';

const ROW_H = 24;

export interface GridBodyCellProps {
  cellId: string;
  value: unknown;
  width: number;
  spec: ColumnEditorSpec;
  edited?: boolean;
  deleted?: boolean;
  /** New-row cell the user hasn't filled — renders blank, not `∅`. */
  unset?: boolean;
  selected?: boolean;
  editing?: boolean;
  editable?: boolean;
  binary?: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onCommit: (value: unknown, move: CellCommitMove) => void;
  onCancel: () => void;
  onNull: () => void;
  onView: () => void;
  nullLabel: string;
}

function GridBodyCellImpl({
  cellId, value, width, spec, edited, deleted, unset, selected, editing, editable, binary,
  onSelect, onStartEdit, onCommit, onCancel, onNull, onView, nullLabel,
}: GridBodyCellProps) {
  const isNull = value == null;
  const text = useMemo(() => (isNull ? '' : cellText(value)), [isNull, value]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const initialRef = useRef(text);
  initialRef.current = text;

  const commit = (raw: string, move: CellCommitMove): void => {
    if (raw === initialRef.current) {
      if (move === 'none') onCancel();
      else onCommit(value, move); // unchanged — just move the cursor
      return;
    }
    onCommit(coerceCellInput(raw, spec), move);
  };

  // The virtualizer unmounts rows scrolled out of view, which never fires blur.
  // Flush the in-flight text so a scroll can't silently drop an edit.
  useEffect(() => {
    if (!editing) return;
    return () => {
      const el = inputRef.current;
      if (el && el.value !== initialRef.current) onCommit(coerceCellInput(el.value, spec), 'none');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (editing) {
    return (
      <div className="flex shrink-0 items-center border-b border-r p-0" style={{ width }} data-cell={cellId}>
        <input
          ref={inputRef}
          autoFocus
          defaultValue={text}
          className="min-w-0 flex-1 bg-background px-2 py-0.5 font-mono text-xs outline-none ring-1 ring-inset ring-primary"
          onBlur={(e) => commit(e.target.value, 'none')}
          onKeyDown={(e) => {
            const input = e.target as HTMLInputElement;
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(input.value, 'down');
            } else if (e.key === 'Tab') {
              e.preventDefault();
              commit(input.value, e.shiftKey ? 'left' : 'right');
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        <button
          type="button"
          className="shrink-0 px-1 text-muted-foreground hover:text-amber-400"
          title={nullLabel}
          onMouseDown={(e) => { e.preventDefault(); onNull(); }}
        >
          <Ban className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-cell={cellId}
      className={cn(
        'shrink-0 truncate border-b border-r px-2 py-0.5 font-mono',
        editable && !binary ? 'cursor-text' : 'cursor-default',
        deleted && 'line-through',
        edited && 'bg-amber-500/15',
        selected && 'ring-1 ring-inset ring-primary/70',
        isNull && !unset && 'italic text-muted-foreground/50',
        binary && 'text-muted-foreground',
      )}
      style={{ width, contentVisibility: 'auto', containIntrinsicSize: `${width}px ${ROW_H}px` }}
      title={binary ? text : text || undefined}
      onMouseDown={onSelect}
      onClick={() => {
        if (hasActiveTextSelection()) return;
        if (editable && !binary) onStartEdit();
        else onView();
      }}
      onDoubleClick={editable && !binary ? onView : undefined}
    >
      {isNull ? (unset ? '' : '∅') : text}
    </div>
  );
}

/** A drag-to-select gesture ends with a click in Chromium — don't turn that
 *  click into an edit/view action when the user was selecting a cell value. */
function hasActiveTextSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}

export const GridBodyCell = memo(GridBodyCellImpl, (previous, next) => (
  previous.cellId === next.cellId
  && Object.is(previous.value, next.value)
  && previous.width === next.width
  && previous.spec === next.spec
  && previous.edited === next.edited
  && previous.deleted === next.deleted
  && previous.unset === next.unset
  && previous.selected === next.selected
  && previous.editing === next.editing
  && previous.editable === next.editable
  && previous.binary === next.binary
  && previous.nullLabel === next.nullLabel
));
