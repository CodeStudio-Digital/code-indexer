/**
 * Slow-call instrumentation for the IPC/handler dispatch path.
 *
 * `timeCall(channel, fn)` wraps one handler invocation; calls slower than
 * the threshold are aggregated into a bounded top-N table keyed by
 * channel. The Electron `bind()` leaf wrapper (handlers-mount.ts) is the
 * single integration point — every renderer→main call flows through it,
 * so a slow backend handler shows up here by name.
 *
 * Each row keeps a bounded ring of recent durations so the snapshot can
 * derive p50/p95/p99 — a single `maxMs` hides whether a channel is
 * uniformly slow or just has a rare cold-start tail. The recorded time is
 * the BACKEND handler duration only; the renderer-side span (route-startup
 * metrics) measures the full round-trip, so `renderer − backend ≈ IPC
 * overhead`.
 *
 * The live aggregate is resettable in memory; each qualifying call is also
 * appended to the persistent perf journal for post-crash reconstruction.
 */

import { enterInFlight, exitInFlight, noteExit } from './freeze-log.js';
import { recordPersistentSlowCall } from './persistent-diagnostics.js';

export interface SlowCallRow {
  channel: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastAt: number;
  /** Percentiles over the bounded recent-sample ring (ms). */
  p50: number;
  p95: number;
  p99: number;
}

const THRESHOLD_MS = 50;
const MAX_CHANNELS = 200;
/** Recent durations kept per channel for percentile estimation. */
const SAMPLE_CAP = 128;

interface ChannelStat {
  channel: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastAt: number;
  /** Ring buffer of recent rounded durations (ms). */
  samples: number[];
  head: number;
}

const table = new Map<string, ChannelStat>();

export function recordSlowCall(channel: string, ms: number): void {
  if (ms < THRESHOLD_MS) return;
  let row = table.get(channel);
  if (!row) {
    if (table.size >= MAX_CHANNELS) return; // bounded — never grow unbounded
    row = { channel, count: 0, totalMs: 0, maxMs: 0, lastAt: 0, samples: [], head: 0 };
    table.set(channel, row);
  }
  const rounded = Math.round(ms);
  const at = Date.now();
  row.count++;
  row.totalMs += rounded;
  row.maxMs = Math.max(row.maxMs, rounded);
  row.lastAt = at;
  // Bounded ring: append until full, then overwrite oldest.
  if (row.samples.length < SAMPLE_CAP) {
    row.samples.push(rounded);
  } else {
    row.samples[row.head] = rounded;
    row.head = (row.head + 1) % SAMPLE_CAP;
  }
  recordPersistentSlowCall(channel, rounded, at);
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/** Wrap a handler invocation with timing. Errors propagate untouched. The
 *  in-flight enter/exit lets the freeze watchdog name the handler that was
 *  running when the main loop stalled (see freeze-log.ts). */
export async function timeCall<T>(channel: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  const token = enterInFlight(channel);
  try {
    return await fn();
  } finally {
    const ms = performance.now() - start;
    exitInFlight(token);
    noteExit(channel, ms);
    recordSlowCall(channel, ms);
  }
}

export function slowCallsSnapshot(): SlowCallRow[] {
  return Array.from(table.values())
    .map((r): SlowCallRow => {
      const sorted = [...r.samples].sort((a, b) => a - b);
      return {
        channel: r.channel,
        count: r.count,
        totalMs: r.totalMs,
        maxMs: r.maxMs,
        lastAt: r.lastAt,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 50);
}

export function resetSlowCalls(): void {
  table.clear();
}
