/**
 * Spec redaction — defense-in-depth scrub of an OpenAPI document before it is
 * hosted publicly. The desktop client already strips secret env VALUES (it exports
 * with `{{var}}` placeholders, never resolved secrets), but a request body can
 * still carry a hard-coded token; this runs the strict rule set over EVERY string
 * value in the spec so nothing secret-shaped survives. Keys are preserved.
 */
import { redactText, type RedactionResult } from './redactor.js';

/** Recursively scrub every string value in an arbitrary JSON value. */
export function redactJson<T>(value: T): RedactionResult<T> {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactText(v, 'strict');
      count += r.redactionCount;
      return r.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, redactionCount: count };
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);

/** Count operations (path × HTTP method) in an OpenAPI doc. Best-effort: tolerant
 *  of a malformed shape (returns 0 rather than throwing). */
export function countOperations(spec: unknown): number {
  const paths = (spec as { paths?: unknown })?.paths;
  if (!paths || typeof paths !== 'object') return 0;
  let n = 0;
  for (const item of Object.values(paths as Record<string, unknown>)) {
    if (item && typeof item === 'object') {
      for (const method of Object.keys(item as Record<string, unknown>)) {
        if (HTTP_METHODS.has(method.toLowerCase())) n += 1;
      }
    }
  }
  return n;
}
