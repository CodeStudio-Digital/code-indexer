/**
 * Frontend mirror of the backend normalizeKvList — parse headers_json/query_json
 * /body_*_json (legacy object OR new array) into KvRow[], and serialize back.
 */
import type { KvRow } from '../types.js';

export function parseRows(json: string | null | undefined): KvRow[] {
  if (json == null) return [];
  let v: unknown;
  try { v = JSON.parse(json); } catch { return []; }
  if (Array.isArray(v)) {
    return v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map((r) => ({
      key: String(r.key ?? ''),
      value: String(r.value ?? ''),
      enabled: r.enabled !== false,
      description: r.description != null ? String(r.description) : undefined,
      src: r.src != null ? String(r.src) : undefined,
    }));
  }
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).map(([key, val]) => ({ key, value: String(val ?? ''), enabled: true }));
  }
  return [];
}

export function stringifyRows(rows: KvRow[]): string {
  return JSON.stringify(rows.filter((r) => r.key || r.value || r.src));
}
