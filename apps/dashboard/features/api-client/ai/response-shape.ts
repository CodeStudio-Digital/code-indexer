/**
 * Derive a privacy-safe SHAPE of a JSON response body — keys + value TYPES, never
 * the actual values — so the AI script assistant knows the structure (to write
 * asserts / save a token) without ever sending tokens/secrets to the model.
 */
const MAX_DEPTH = 4;
const MAX_LEN = 1500;

function shapeOf(value: unknown, depth: number): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth >= MAX_DEPTH || value.length === 0 ? ['…'] : [shapeOf(value[0], depth + 1)];
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shapeOf(v, depth + 1);
    return out;
  }
  return typeof value; // 'string' | 'number' | 'boolean'
}

/** JSON body → shape string (keys+types). Returns undefined for non-JSON bodies. */
export function jsonShape(body: string | null | undefined): string | undefined {
  if (!body || body.length > 256 * 1024 || !body.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  try {
    const s = JSON.stringify(shapeOf(parsed, 0), null, 2);
    return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}\n…(truncated)` : s;
  } catch { return undefined; }
}
