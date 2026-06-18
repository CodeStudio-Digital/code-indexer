/**
 * Two-way sync between the URL bar (path_template, which may carry `?query`) and
 * the Query key/value grid. Editing one updates the other. Parsing is manual (no
 * URLSearchParams — it would reorder and decode `{{var}}` templates); encoding is
 * deferred to the server at send time.
 *
 * Disabled query rows aren't representable in the URL string, so editing the URL
 * bar keeps existing disabled rows and replaces the enabled ones.
 */
import type { KvRow } from './types.js';

export function serializeQuery(rows: KvRow[]): string {
  return rows.filter((r) => r.enabled && r.key).map((r) => `${r.key}=${r.value}`).join('&');
}

function parseQuery(qs: string): KvRow[] {
  if (!qs) return [];
  return qs.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    return eq < 0
      ? { key: pair, value: '', enabled: true }
      : { key: pair.slice(0, eq), value: pair.slice(eq + 1), enabled: true };
  });
}

export function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

export function useQuerySync(args: {
  pathTemplate: string;
  queryRows: KvRow[];
  onPath: (p: string) => void;
  onQuery: (rows: KvRow[]) => void;
}): { onUrlEdit: (next: string) => void; onRowsEdit: (rows: KvRow[]) => void } {
  const { pathTemplate, queryRows, onPath, onQuery } = args;

  const onUrlEdit = (next: string): void => {
    onPath(next);
    const q = next.indexOf('?');
    const parsed = q < 0 ? [] : parseQuery(next.slice(q + 1));
    // Map the parsed (enabled) params back onto the existing rows positionally,
    // keeping disabled rows exactly where they are. Enabled rows are replaced in
    // order; extra parsed rows are appended; removed ones drop out.
    let pi = 0;
    const merged: KvRow[] = [];
    for (const r of queryRows) {
      if (r.enabled) { if (pi < parsed.length) merged.push(parsed[pi++]); }
      else merged.push(r);
    }
    while (pi < parsed.length) merged.push(parsed[pi++]);
    onQuery(merged);
  };

  const onRowsEdit = (rows: KvRow[]): void => {
    onQuery(rows);
    const qs = serializeQuery(rows);
    const basePath = stripQuery(pathTemplate);
    onPath(qs ? `${basePath}?${qs}` : basePath);
  };

  return { onUrlEdit, onRowsEdit };
}
