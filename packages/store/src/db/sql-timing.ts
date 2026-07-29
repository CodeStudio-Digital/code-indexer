/**
 * Optional timing for synchronous better-sqlite3 statement execution.
 *
 * WHY: `better-sqlite3` is fully synchronous, so every `run`/`get`/`all` on the
 * Electron main thread blocks the whole app — including a `busy_timeout` wait,
 * which busy-waits inside native code and is invisible to any JS-level probe.
 * The freeze journal could see THAT the main thread stalled but never WHICH
 * statement did it, because attribution only covered ~7 hand-wrapped IPC
 * handlers. This patches the prototype ONCE so every prepared statement in the
 * process is timed, wherever it was created.
 *
 * Cost when disabled (the default, and what workers/CLI/tests get): one
 * `sink === null` check plus a direct delegate. Enabled it is two
 * `performance.now()` calls (~100ns) against a 1–5µs point query.
 *
 * `iterate` is deliberately NOT patched: it returns a generator, so timing it
 * would measure generator creation rather than row consumption. That cost is
 * already inside the caller's own synchronous section.
 */
import type { Database as DB } from 'better-sqlite3';
import { performance } from 'node:perf_hooks';

export type SqlCallSink = (sql: string, ms: number) => void;

let sink: SqlCallSink | null = null;
let patched = false;

/**
 * Install (or clear with `null`) the process-wide sink.
 *
 * The null default is load-bearing: the patch is global to the process, so
 * every connection in it — worker handles, the CLI, test fixtures — runs
 * through these wrappers. They must cost nothing until someone opts in.
 */
export function setSqlCallSink(next: SqlCallSink | null): void {
  sink = process.env.MCP_SQL_TIMING === '0' ? null : next;
}

export function sqlCallSinkActive(): boolean {
  return sink !== null;
}

/**
 * Patch `Statement.prototype` for this process. Idempotent; safe to call from
 * every connection that opens. `db` is used only to reach the prototype —
 * better-sqlite3 does not export the Statement class.
 */
export function installSqlTiming(db: DB): void {
  if (patched) return;
  let probe: unknown;
  try {
    probe = db.prepare('SELECT 1');
  } catch {
    return; // Unusable handle — never let instrumentation break the caller.
  }
  const proto = Object.getPrototypeOf(probe) as Record<string, unknown>;
  if (!proto) return;
  patched = true;

  for (const method of ['run', 'get', 'all'] as const) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    const fn = original as (...args: unknown[]) => unknown;
    proto[method] = function patchedMethod(this: { source?: string }, ...args: unknown[]): unknown {
      const active = sink;
      if (active === null) return fn.apply(this, args);
      const start = performance.now();
      try {
        return fn.apply(this, args);
      } finally {
        // `source` is a cached getter on the statement — cheap, no re-parse.
        active(this.source ?? '(unknown)', performance.now() - start);
      }
    };
  }
}

/** Test seam — restores the "never patched" state for a fresh install. */
export function resetSqlTimingForTests(): void {
  sink = null;
  patched = false;
}

// ─── Label normalization ─────────────────────────────────────────────────

const MAX_LABEL_CHARS = 80;
const MAX_CACHED_LABELS = 300;
const labelCache = new Map<string, string>();

/**
 * Collapse a statement into a short, stable label suitable for a metrics key.
 * Bounded so a process that prepares many distinct statements cannot grow the
 * cache without limit.
 */
export function sqlLabel(sql: string): string {
  const cached = labelCache.get(sql);
  if (cached !== undefined) return cached;
  const normalized = sql.replace(/\s+/g, ' ').trim();
  const label = normalized.length > MAX_LABEL_CHARS
    ? `${normalized.slice(0, MAX_LABEL_CHARS)}…`
    : normalized;
  if (labelCache.size < MAX_CACHED_LABELS) labelCache.set(sql, label);
  return label;
}
