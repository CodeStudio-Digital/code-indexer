/**
 * Pending-changeset state for the editable data grid. Tracks per-row cell edits,
 * deleted rows, and appended new rows — keyed by the row's PRIMARY KEY values so
 * edits survive re-render. `buildChanges` turns the changeset into the
 * `editRow` inputs (parameterized, PK-scoped) used for both preview and apply.
 */
import { useCallback, useMemo, useState } from 'react';
import { buildRowChanges, rowKeyOf, sameValue, type Row, type RowChangeInput } from './build-row-changes.js';

export { rowKeyOf };
export type { Row, RowChangeInput };

interface NewRow {
  tempId: string;
  values: Row;
}

export interface GridEdits {
  edited: Record<string, Row>; // rowKey → changed columns
  deleted: Set<string>; // rowKeys
  newRows: NewRow[];
  dirtyCount: number;
  /** Record a cell edit. Pass `original` so typing the old value back clears it. */
  setCell: (rowKey: string, col: string, value: unknown, original?: unknown) => void;
  toggleDelete: (rowKey: string) => void;
  addRow: () => void;
  setNewCell: (tempId: string, col: string, value: unknown) => void;
  removeNewRow: (tempId: string) => void;
  revertAll: () => void;
  /** Effective value for a cell (edit override → original). */
  cellValue: (rowKey: string, col: string, original: unknown) => unknown;
  isEdited: (rowKey: string, col: string) => boolean;
  buildChanges: (rows: Row[], pkCols: string[], schema: string | undefined, table: string) => RowChangeInput[];
}

/** "Caller did not tell us the stored value" — distinct from a genuine `undefined`. */
const UNKNOWN = Symbol('unknown-original');

let tempSeq = 0;

export function useGridEdits(): GridEdits {
  const [edited, setEdited] = useState<Record<string, Row>>({});
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [newRows, setNewRows] = useState<NewRow[]>([]);

  const setCell = useCallback((rowKey: string, col: string, value: unknown, original: unknown = UNKNOWN) => {
    setEdited((prev) => {
      const row = { ...(prev[rowKey] ?? {}) };
      // Restoring the stored value is not an edit — drop the column (and the row
      // entry when it was the last one) so the pending counter stays honest.
      if (original !== UNKNOWN && sameValue(value, original)) delete row[col];
      else row[col] = value;
      if (Object.keys(row).length === 0) {
        if (!(rowKey in prev)) return prev;
        const next = { ...prev };
        delete next[rowKey];
        return next;
      }
      return { ...prev, [rowKey]: row };
    });
  }, []);

  const toggleDelete = useCallback((rowKey: string) => {
    setDeleted((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  const addRow = useCallback(() => {
    tempSeq += 1;
    setNewRows((prev) => [...prev, { tempId: `new:${tempSeq}`, values: {} }]);
  }, []);

  const setNewCell = useCallback((tempId: string, col: string, value: unknown) => {
    setNewRows((prev) => prev.map((r) => (r.tempId === tempId ? { ...r, values: { ...r.values, [col]: value } } : r)));
  }, []);

  const removeNewRow = useCallback((tempId: string) => {
    setNewRows((prev) => prev.filter((r) => r.tempId !== tempId));
  }, []);

  const revertAll = useCallback(() => {
    setEdited({});
    setDeleted(new Set());
    setNewRows([]);
  }, []);

  const cellValue = useCallback(
    (rowKey: string, col: string, original: unknown) => {
      const row = edited[rowKey];
      return row && col in row ? row[col] : original;
    },
    [edited],
  );

  const isEdited = useCallback((rowKey: string, col: string) => !!edited[rowKey] && col in edited[rowKey], [edited]);

  const buildChanges = useCallback(
    (rows: Row[], pkCols: string[], schema: string | undefined, table: string): RowChangeInput[] =>
      buildRowChanges({ edited, deleted, newRows }, rows, pkCols, schema, table),
    [edited, deleted, newRows],
  );

  const dirtyCount = useMemo(
    () => Object.keys(edited).length + deleted.size + newRows.filter((r) => Object.keys(r.values).length > 0).length,
    [edited, deleted, newRows],
  );

  return useMemo(() => ({
    edited,
    deleted,
    newRows,
    dirtyCount,
    setCell,
    toggleDelete,
    addRow,
    setNewCell,
    removeNewRow,
    revertAll,
    cellValue,
    isEdited,
    buildChanges,
  }), [
    edited, deleted, newRows, dirtyCount, setCell, toggleDelete, addRow,
    setNewCell, removeNewRow, revertAll, cellValue, isEdited, buildChanges,
  ]);
}
