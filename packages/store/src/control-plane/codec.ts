import { createHash } from 'node:crypto';

export type ControlPlaneJsonValue =
  | null
  | boolean
  | number
  | string
  | ControlPlaneJsonValue[]
  | { [key: string]: ControlPlaneJsonValue };

function normalizeJson(value: unknown, seen: Set<object>, path: string): ControlPlaneJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Control-plane JSON contains a non-finite number at ${path}`);
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`Control-plane JSON contains unsupported ${typeof value} at ${path}`);
  }
  if (typeof value !== 'object') throw new TypeError(`Control-plane JSON contains unsupported value at ${path}`);
  if (seen.has(value)) throw new TypeError(`Control-plane JSON contains a cycle at ${path}`);

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJson(item, seen, `${path}[${index}]`));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = prototype?.constructor?.name ?? 'unknown';
      throw new TypeError(`Control-plane JSON contains non-plain object ${name} at ${path}`);
    }
    const out: Record<string, ControlPlaneJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalizeJson((value as Record<string, unknown>)[key], seen, `${path}.${key}`);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function stableControlPlaneJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new Set(), '$'));
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashControlPlanePayload(value: unknown): string {
  return sha256Hex(stableControlPlaneJson(value));
}

export function parseControlPlaneJson<T>(value: string | null, fallback: T): T {
  if (value == null) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
