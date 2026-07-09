/**
 * Session-persistent key-value store for code_exec scripts.
 *
 * WHY (telemetry jul/2026): 82% of file reads happen INSIDE code_exec
 * scripts, whose node:vm sandbox dies at the end of each call. With no
 * place to carry content forward, the model (a) echoes whole files into
 * the script output — ~23.7M chars of code_exec output vs 23.9M chars
 * read, a ~1:1 echo ratio, all landing in history — and (b) re-reads the
 * same file in a later script (2,572 cross-script re-reads observed).
 * The stash removes the NEED for both: `stash.set('x', content)` in one
 * script, `stash.get('x')` in the next — nothing echoed, nothing re-read.
 *
 * Values are JSON round-tripped on set: isolates vm-realm objects from the
 * host and between scripts (a later sandbox never sees live objects from a
 * dead one). The store hangs off ToolContext — one per session, shared by
 * every code_exec call in it. NOT persisted to disk: a fresh app process
 * starts empty (scripts must tolerate a missing key, same as any cache).
 */

const DEFAULT_MAX_BYTES = 2_000_000;

export function stashMaxBytes(): number {
  const v = process.env.CODER_CODE_EXEC_STASH_MAX_BYTES;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_BYTES;
}

export interface CodeExecStash {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  keys(): string[];
  /** Serialized bytes currently held (cap accounting). */
  usedBytes(): number;
}

export function createCodeExecStash(maxBytes: number = stashMaxBytes()): CodeExecStash {
  const store = new Map<string, string>(); // key → serialized JSON
  let used = 0;

  const sizeSummary = (): string =>
    [...store.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5)
      .map(([k, v]) => `${k}=${(v.length / 1024).toFixed(0)}KB`)
      .join(', ') || '(empty)';

  return {
    get(key) {
      const raw = store.get(String(key));
      return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
    },
    set(key, value) {
      const k = String(key);
      if (value === undefined) {
        throw new Error('stash.set: value is undefined — use stash.delete(key) to remove a key');
      }
      let raw: string | undefined;
      try {
        raw = JSON.stringify(value);
      } catch (e) {
        throw new Error(
          `stash.set: value for "${k}" is not JSON-serializable: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (raw === undefined) {
        // JSON.stringify(function/symbol) → undefined.
        throw new Error(`stash.set: value for "${k}" is not JSON-serializable (functions/symbols cannot be stashed)`);
      }
      const prevLen = store.get(k)?.length ?? 0;
      const next = used - prevLen + raw.length;
      if (next > maxBytes) {
        throw new Error(
          `stash.set: cap ${maxBytes} bytes exceeded (would use ${next}; largest keys: ${sizeSummary()}). ` +
          'Delete keys with stash.delete(key) or stash smaller extracts.',
        );
      }
      store.set(k, raw);
      used = next;
    },
    delete(key) {
      const k = String(key);
      const raw = store.get(k);
      if (raw === undefined) return false;
      used -= raw.length;
      store.delete(k);
      return true;
    },
    keys() {
      return [...store.keys()];
    },
    usedBytes() {
      return used;
    },
  };
}

/**
 * Sandbox-facing binding. Thin arrow-function wrappers so the vm script can
 * call `stash.get('x')` without host `this` issues; errors thrown here (cap
 * exceeded, unserializable value) propagate into the script as catchable
 * exceptions — same contract as nested tool failures.
 */
export function buildStashSandboxApi(stash: CodeExecStash): Record<string, unknown> {
  return {
    get: (k: unknown) => stash.get(String(k)),
    set: (k: unknown, v: unknown) => { stash.set(String(k), v); },
    delete: (k: unknown) => stash.delete(String(k)),
    keys: () => stash.keys(),
    usedBytes: () => stash.usedBytes(),
  };
}
