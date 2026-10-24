import { type ColumnEditorSpec } from './column-editor.js';

export const ROW_H = 24;

export const ROWNUM_W = 52;

export const DEFAULT_COL_W = 168;

export const MIN_COL_W = 60;

export const MAX_AUTOFIT_W = 520;

export type SortState = { col: string; dir: 'asc' | 'desc' } | null;

export type Cursor = { row: number; col: number };

export function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a).localeCompare(String(b));
}

export const TEXT_SPEC: ColumnEditorSpec = { kind: 'text', enumValues: [] };
