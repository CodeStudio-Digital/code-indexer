/**
 * Gated micro-profiler for splitting a slow handler's time into named
 * sub-sections (git spawn vs disk vs SQL vs serialization). OFF by default
 * — when `MCP_PERF_BREAKDOWN` is unset the wrappers are a straight
 * pass-through with zero allocation, so hot handlers pay nothing in prod.
 *
 * The `slow-ipc` table answers "which channel is slow"; this answers
 * "where inside the handler the time went". Keyed by a logical scope the
 * handler picks (e.g. `projectGit.status`) — independent of the IPC
 * channel name, which the handler doesn't know.
 *
 * Surface: GET /api/admin/perf/breakdown. In-memory, reset alongside it.
 */

const ENABLED = process.env.MCP_PERF_BREAKDOWN === '1';

interface Section {
  count: number;
  totalMs: number;
  maxMs: number;
}

interface BreakdownRow {
  scope: string;
  label: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

const table = new Map<string, Map<string, Section>>();

export function breakdownEnabled(): boolean {
  return ENABLED;
}

function record(scope: string, label: string, ms: number): void {
  let scopeMap = table.get(scope);
  if (!scopeMap) {
    scopeMap = new Map();
    table.set(scope, scopeMap);
  }
  let section = scopeMap.get(label);
  if (!section) {
    section = { count: 0, totalMs: 0, maxMs: 0 };
    scopeMap.set(label, section);
  }
  const rounded = Math.round(ms * 10) / 10;
  section.count++;
  section.totalMs = Math.round((section.totalMs + rounded) * 10) / 10;
  section.maxMs = Math.max(section.maxMs, rounded);
}

/**
 * Time one labelled sub-section of a handler. When disabled this is a
 * straight synchronous `return fn()` — no Promise wrapping, no allocation.
 * Preserves the callee's shape: a sync `fn` returns sync, an async `fn`
 * returns its Promise (timed via `.finally`). Errors propagate untouched.
 */
export function timeSection<T>(scope: string, label: string, fn: () => T): T {
  if (!ENABLED) return fn();
  const start = performance.now();
  let result: T;
  try {
    result = fn();
  } catch (err) {
    record(scope, label, performance.now() - start);
    throw err;
  }
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    return (result as unknown as Promise<unknown>).finally(() =>
      record(scope, label, performance.now() - start),
    ) as unknown as T;
  }
  record(scope, label, performance.now() - start);
  return result;
}

export function breakdownSnapshot(): BreakdownRow[] {
  const rows: BreakdownRow[] = [];
  for (const [scope, scopeMap] of table) {
    for (const [label, section] of scopeMap) {
      rows.push({ scope, label, count: section.count, totalMs: section.totalMs, maxMs: section.maxMs });
    }
  }
  return rows.sort((a, b) => b.totalMs - a.totalMs);
}

export function resetBreakdown(): void {
  table.clear();
}
