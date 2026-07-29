/**
 * Shared grid helpers used by the virtual result grid and the editable grid.
 *
 * `cellText` is the ONE place a driver value becomes display text. Drivers hand
 * back real JS values (pg returns `Date` for timestamps, mysql2 `Buffer` for
 * BLOB/BINARY, every engine `bigint` for 64-bit ints), so a bare `String(v)`
 * printed locale-formatted dates ("Sat Jul 25 2026 00:00:00 GMT-0300 (…)") and
 * `JSON.stringify` turned a 2 KB blob into `{"0":137,"1":80,…}`. Both are wrong
 * on screen AND dangerous inline: the grid seeds the editor from this text, so a
 * mangled rendering became the value written back to the row.
 */
import type { DbQueryResult } from '../types.js';

export function columnNames(result: DbQueryResult): string[] {
  if (result.fields.length > 0) return result.fields.map((f) => f.name);
  return result.rows[0] ? Object.keys(result.rows[0]) : [];
}

/** JSON-transported Buffer (`{type:'Buffer',data:[…]}`) — the HTTP fallback shape. */
function bufferBytes(value: object): number[] | null {
  const candidate = value as { type?: unknown; data?: unknown };
  return candidate.type === 'Buffer' && Array.isArray(candidate.data) ? (candidate.data as number[]) : null;
}

const MAX_BLOB_PREVIEW_BYTES = 24;

function hexPreview(bytes: ArrayLike<number>, byteLength: number): string {
  const shown = Math.min(byteLength, MAX_BLOB_PREVIEW_BYTES);
  let hex = '';
  for (let i = 0; i < shown; i += 1) hex += (bytes[i] & 0xff).toString(16).padStart(2, '0');
  return `0x${hex}${byteLength > shown ? `… (${byteLength} B)` : ''}`;
}

/**
 * Display text for one cell value. NULL is rendered by the caller (the grid
 * shows `∅` in a muted style), so this returns '' for null/undefined.
 */
export function cellText(v: unknown): string {
  if (v == null) return '';
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(v);
    case 'object':
      break;
    default:
      return String(v);
  }
  // Timestamps: ISO without the `T`/`Z` noise, which is what every SQL client shows.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const bytes = v as unknown as Uint8Array;
    return hexPreview(bytes, bytes.length);
  }
  if (v instanceof ArrayBuffer) {
    const bytes = new Uint8Array(v);
    return hexPreview(bytes, bytes.length);
  }
  const bytes = bufferBytes(v);
  if (bytes) return hexPreview(bytes, bytes.length);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** True when the value is binary — the grid must not offer it for inline edit. */
export function isBinaryValue(v: unknown): boolean {
  if (v == null || typeof v !== 'object') return false;
  return ArrayBuffer.isView(v) || v instanceof ArrayBuffer || bufferBytes(v) != null;
}
