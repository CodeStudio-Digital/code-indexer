/**
 * Pending-changeset state for the editable data grid. Tracks per-row cell edits,
 * deleted rows, and appended new rows — keyed by the row's PRIMARY KEY values so
 * edits survive re-render. `buildChanges` turns the changeset into the
 * `editRow` inputs (parameterized, PK-scoped) used for both preview and apply.
 */
import { useCallback, useMemo, useState } from 'react';
import type { DbRowChangeKind } from '../types.js';

export type Row = Record<string, unknown>;

export interface RowChangeInput {
  op: DbRowChangeKind;
  pk?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

/** Stable key for a row from its PK column values. */
export function rowKeyOf(row: Row, pkCols: string[]): string {
  return JSON.stringify(pkCols.map((c) => row[c] ?? null));
}

interface NewRow {
  tempId: string;
  values: Row;
}

export interface GridEdits {
  edited: Record<string, Row>; // rowKey → changed columns
  deleted: Set<string>; // rowKeys
  newRows: NewRow[];
  dirtyCount: number;
  setCell: (rowKey: string, col: string, value: unknown) => void;
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

let tempSeq = 0;

export function useGridEdits(): GridEdits {
  const [edited, setEdited] = useState<Record<string, Row>>({});
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [newRows, setNewRows] = useState<NewRow[]>([]);

  const setCell = useCallback((rowKey: string, col: string, value: unknown) => {
    setEdited((prev) => ({ ...prev, [rowKey]: { ...(prev[rowKey] ?? {}), [col]: value } }));
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
    (rows: Row[], pkCols: string[], schema: string | undefined, table: string): RowChangeInput[] => {
      const out: RowChangeInput[] = [];
      for (const row of rows) {
        const rk = rowKeyOf(row, pkCols);
        const pk = Object.fromEntries(pkCols.map((c) => [c, row[c]]));
        if (deleted.has(rk)) {
          out.push({ op: 'delete', pk });
        } else if (edited[rk]) {
          out.push({ op: 'update', pk, values: edited[rk] });
        }
      }
      for (const nr of newRows) {
        const values = Object.fromEntries(Object.entries(nr.values).filter(([, v]) => v !== undefined));
        if (Object.keys(values).length > 0) out.push({ op: 'insert', values });
      }
      // schema/table are attached by the caller (editRow input needs them).
      return out.map((c) => ({ ...c }));
    },
    [edited, deleted, newRows],
  );

  const dirtyCount = useMemo(
    () => Object.keys(edited).length + deleted.size + newRows.filter((r) => Object.keys(r.values).length > 0).length,
    [edited, deleted, newRows],
  );

  return {
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
  };
}
