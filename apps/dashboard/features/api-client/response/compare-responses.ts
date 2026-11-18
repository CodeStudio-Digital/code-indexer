import type { SendResponse } from '../types.js';

type Json = string | number | boolean | null | Json[] | { [name: string]: Json };
export interface ResponseChange { path: string; before?: string; after?: string }
const BODY_LIMIT = 256 * 1024;
const ROW_LIMIT = 100;
export interface ComparisonResponse {
  status: number; ms: number; size?: number; truncated?: boolean; body: string | null;
}

export function comparisonBaseline(r: SendResponse): ComparisonResponse {
  return { status: r.status, ms: r.ms, size: r.size ?? new TextEncoder().encode(r.body).length,
    truncated: r.truncated, body: r.body.length > BODY_LIMIT ? null : r.body };
}

function preview(value: Json | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).length}}`;
  const text = JSON.stringify(value);
  return text.length > 240 ? text.slice(0, 239) + '…' : text;
}

/** JSON Pointer paths for JSON, one-based line numbers for other bodies. */
export function compareBodies(before: ComparisonResponse, after: ComparisonResponse) {
  const changes: ResponseChange[] = [];
  let limited = !!(before.truncated || after.truncated);
  let visited = 0;
  function change(path: string, left?: string, right?: string) {
    if (changes.length >= ROW_LIMIT) { limited = true; return; }
    changes.push({ path, before: left, after: right });
  }
  function visit(left: Json | undefined, right: Json | undefined, path: string, depth: number) {
    if (++visited > 16000 || depth > 64) { limited = true; return; }
    if (left === right) return;
    if (left && right && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
      const l = left as Record<string, Json>, r = right as Record<string, Json>;
      for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
        if (visited >= 16000 || changes.length >= ROW_LIMIT) { limited = true; break; }
        const pointer = path + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
        visit(Object.hasOwn(l, key) ? l[key] : undefined, Object.hasOwn(r, key) ? r[key] : undefined, pointer, depth + 1);
      }
    } else {
      change(path || '$', preview(left), preview(right));
    }
  }
  if (before.body === null || after.body === null || before.body.length > BODY_LIMIT || after.body.length > BODY_LIMIT) return { changes, limited: true };
  if (before.body === after.body) return { changes, limited };
  try {
    const left = JSON.parse(before.body) as Json;
    const right = JSON.parse(after.body) as Json;
    visit(left, right, '', 0);
  } catch {
    const left = before.body.split(/\r?\n/), right = after.body.split(/\r?\n/);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (left[i] === right[i]) continue;
      if (changes.length >= ROW_LIMIT) { limited = true; break; }
      change(String(i + 1), preview(left[i]), preview(right[i]));
    }
  }
  return { changes, limited };
}
