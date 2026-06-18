/**
 * Bulk-edit serialization for the KeyValueGrid — Postman's `Key: Value` line
 * format. A leading `#` disables a row. Description is dropped in bulk mode
 * (Postman parity); it survives only in grid mode. Pure + testable.
 */
import type { KvRow } from '../types.js';

export function rowsToBulk(rows: KvRow[]): string {
  return rows
    .filter((r) => r.key || r.value)
    .map((r) => `${r.enabled ? '' : '# '}${r.key}: ${r.value}`)
    .join('\n');
}

export function bulkToRows(text: string): KvRow[] {
  const out: KvRow[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const enabled = !line.startsWith('#');
    const body = enabled ? line : line.replace(/^#\s*/, '');
    const idx = body.indexOf(':');
    if (idx < 0) { out.push({ key: body.trim(), value: '', enabled }); continue; }
    out.push({ key: body.slice(0, idx).trim(), value: body.slice(idx + 1).trim(), enabled });
  }
  return out;
}
