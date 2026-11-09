/**
 * Pure translation of a grid changeset into the parameterized row mutations the
 * `editRows` endpoint applies. Split out of `use-grid-edits` so it is testable
 * without React — this is the step that broke silently before: the hook dropped
 * the caller's `schema`/`table`, so every change reached the server without a
 * relation and the DML builder produced an unusable statement.
 */
import type { DbRowChangeKind } from '../types.js';

export type Row = Record<string, unknown>;

export interface RowChangeInput {
  op: DbRowChangeKind;
  /** Target relation — REQUIRED by the server's DML builder (quoteRelation). */
  schema?: string;
  table: string;
  pk?: Record<string, unknown>;
  values?: Record<string, unknown>;
  original?: Record<string, unknown>;
}

export interface ChangeSetState {
  /** rowKey → changed columns. */
  edited: Record<string, Row>;
  deleted: ReadonlySet<string>;
  newRows: Array<{ tempId: string; values: Row }>;
}

/** Stable key for a row from its PK column values. */
export function rowKeyOf(row: Row, pkCols: string[]): string {
  return JSON.stringify(pkCols.map((c) => row[c] ?? null));
}

/** Two grid values are the same edit-wise (avoids emitting a no-op UPDATE). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a != null && b != null && typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

export function buildRowChanges(
  state: ChangeSetState,
  rows: Row[],
  pkCols: string[],
  schema: string | undefined,
  table: string,
): RowChangeInput[] {
  const out: RowChangeInput[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const rk = rowKeyOf(row, pkCols);
    // A page can repeat a row key when the "primary key" isn't unique in the
    // result (custom SQL projection). Emit one change per key, never two.
    if (seen.has(rk)) continue;
    seen.add(rk);
    const pk = Object.fromEntries(pkCols.map((c) => [c, row[c]]));
    if (state.deleted.has(rk)) {
      out.push({ op: 'delete', schema, table, pk, original: { ...row } });
      continue;
    }
    const patch = state.edited[rk];
    if (!patch) continue;
    // Drop columns the user typed back to their stored value.
    const values = Object.fromEntries(
      Object.entries(patch).filter(([col, value]) => !sameValue(value, row[col])),
    );
    if (Object.keys(values).length > 0) out.push({ op: 'update', schema, table, pk, values, original: { ...row } });
  }
  for (const nr of state.newRows) {
    const values = Object.fromEntries(Object.entries(nr.values).filter(([, v]) => v !== undefined));
    if (Object.keys(values).length > 0) out.push({ op: 'insert', schema, table, values });
  }
  return out;
}
