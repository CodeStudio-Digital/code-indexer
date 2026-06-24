/**
 * Shared grid helpers used by the virtual result grid and the editable grid.
 */
import type { DbQueryResult } from '../types.js';

export function columnNames(result: DbQueryResult): string[] {
  if (result.fields.length > 0) return result.fields.map((f) => f.name);
  return result.rows[0] ? Object.keys(result.rows[0]) : [];
}

export function cellText(v: unknown): string {
  if (v == null) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
