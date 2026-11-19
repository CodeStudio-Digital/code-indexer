/**
 * Two-way sync between the URL bar (path_template, which may carry `?query`) and
 * the Query key/value grid. Rows hold decoded values, including repeated keys.
 * Templates remain editable in the URL and resolve at send time.
 *
 * Disabled query rows aren't representable in the URL string, so editing the URL
 * bar keeps existing disabled rows and replaces the enabled ones.
 */
import type { KvRow } from './types.js';

export function serializeQuery(rows: KvRow[]): string {
  const encode = (s: string) => new URLSearchParams([['', s]]).toString().slice(1)
    .replace(/%7B%7B([\w.-]+)%7D%7D/gi, '{{$1}}');
  return rows.filter(r => r.enabled && r.key).map(r => `${encode(r.key)}=${encode(r.value)}`).join('&');
}

export function withQuery(url: string, rows: KvRow[]): string {
  const hash = url.indexOf('#');
  const path = hash < 0 ? url : url.slice(0, hash);
  const query = serializeQuery(rows);
  return path.split('?')[0] + (query ? '?' + query : '') + (hash < 0 ? '' : url.slice(hash));
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
    const path = next.split('#', 1)[0];
    const q = path.indexOf('?');
    const parsed = q < 0 ? [] : Array.from(new URLSearchParams(path.slice(q + 1)), ([key, value]) => ({ key, value, enabled: true }));
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
    onPath(withQuery(pathTemplate, rows));
  };

  return { onUrlEdit, onRowsEdit };
}
