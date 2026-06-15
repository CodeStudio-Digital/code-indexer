/**
 * Slow-call instrumentation for the IPC/handler dispatch path.
 *
 * `timeCall(channel, fn)` wraps one handler invocation; calls slower than
 * the threshold are aggregated into a bounded top-N table keyed by
 * channel. The Electron `bind()` leaf wrapper (handlers-mount.ts) is the
 * single integration point — every renderer→main call flows through it,
 * so a slow backend handler shows up here by name.
 *
 * All in-memory, reset via POST /api/admin/perf/slow-ipc/reset.
 */

export interface SlowCallRow {
  channel: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastAt: number;
}

const THRESHOLD_MS = 50;
const MAX_CHANNELS = 200;

const table = new Map<string, SlowCallRow>();

export function recordSlowCall(channel: string, ms: number): void {
  if (ms < THRESHOLD_MS) return;
  let row = table.get(channel);
  if (!row) {
    if (table.size >= MAX_CHANNELS) return; // bounded — never grow unbounded
    row = { channel, count: 0, totalMs: 0, maxMs: 0, lastAt: 0 };
    table.set(channel, row);
  }
  row.count++;
  row.totalMs += Math.round(ms);
  row.maxMs = Math.max(row.maxMs, Math.round(ms));
  row.lastAt = Date.now();
}

/** Wrap a handler invocation with timing. Errors propagate untouched. */
export async function timeCall<T>(channel: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordSlowCall(channel, performance.now() - start);
  }
}

export function slowCallsSnapshot(): SlowCallRow[] {
  return Array.from(table.values()).sort((a, b) => b.totalMs - a.totalMs).slice(0, 50);
}

export function resetSlowCalls(): void {
  table.clear();
}
