/**
 * Evidence sources for classifying a main-thread stall.
 *
 * WHY THIS EXISTS: `performance.eventLoopUtilization()` is unusable in the
 * Electron main process. Node guards it with
 *   `if (nodeTiming.loopStart <= 0) return { idle: 0, active: 0, utilization: 0 }`
 * and Electron drives libuv from the Chromium message pump
 * (`NodeBindings::UvRunOnce()`) instead of `node::SpinEventLoop()`, so the
 * LOOP_START milestone is never marked and `loopStart` stays -1 forever.
 * ELU therefore returns active:0 ALWAYS — which made `attributeStall` take its
 * `active/window < BUSY_FRACTION` branch every time and label 100% of stalls
 * `starved`, leaving the handler/background/event-loop branches dead code.
 * (Measured: 185 journal records, every one `starved` with `activeMs: 0`, over
 * windows from 451ms to 34s.)
 *
 * The replacements, none of which depend on ELU:
 *   - `eluTrusted()` — probes `loopStart` so ELU is used only where it works
 *     (plain Node: the http-api served over HTTP, tests, the CLI).
 *   - GC observer — `PerformanceObserver({entryTypes:['gc']})` DOES work here,
 *     so a GC pause can be proven rather than guessed at.
 *   - Sync accounting — instrumented sections report how long they actually ran
 *     synchronously. Unlike `timeCall` wall time (which spans `await`s and so
 *     says nothing about blocking), this is real main-thread busy time.
 */
import { performance, PerformanceObserver } from 'node:perf_hooks';

/** Ticks the watchdog may observe an untrusted ELU before we say so out loud. */
const ELU_PROBE_TICKS = 40;
/** GC entries retained; ~1s of pauses at any plausible rate. */
const GC_RING = 64;
/** Distinct sync labels tracked before new ones are ignored (bounded memory). */
const MAX_SYNC_LABELS = 512;

// ─── ELU trust probe ─────────────────────────────────────────────────────

let eluAvailable: boolean | null = null;
let eluProbes = 0;
let eluWarned = false;

/**
 * `true` once the runtime is known to maintain loop timing. Latches: `loopStart`
 * is set once during boot and never cleared, so a single positive is final.
 */
function eluTrusted(): boolean {
  if (eluAvailable) return true;
  const loopStart = performance.nodeTiming?.loopStart ?? -1;
  if (loopStart > 0) {
    eluAvailable = true;
    return true;
  }
  eluAvailable = false;
  if (++eluProbes === ELU_PROBE_TICKS && !eluWarned) {
    eluWarned = true;
    console.warn(
      '[perf] eventLoopUtilization is unavailable in this runtime (Electron main drives libuv from the ' +
        'Chromium message pump, so nodeTiming.loopStart is never set). Stall classification uses ' +
        'self-reported sync accounting + GC observation instead; stalls with no instrumented work are ' +
        'reported as `unattributed`, never `starved`.',
    );
  }
  return false;
}

/**
 * Active ms over the window, or `null` when the runtime cannot report it.
 * `null` is the whole point: it is what stops a stall from being called
 * `starved` (a positive claim that the loop was idle) on no evidence.
 */
export function eluActiveMs(
  prev: ReturnType<typeof performance.eventLoopUtilization> | undefined,
  now: ReturnType<typeof performance.eventLoopUtilization>,
): number | null {
  if (!prev || !eluTrusted()) return null;
  return performance.eventLoopUtilization(now, prev).active;
}

// ─── GC observation ──────────────────────────────────────────────────────

interface GcPause { start: number; end: number; kind: number }
const gcPauses: GcPause[] = [];
let gcObserver: PerformanceObserver | null = null;

/** Idempotent. Disabled with `MCP_PERF_GC_OBSERVER=0`. */
export function startGcObserver(): void {
  if (gcObserver || process.env.MCP_PERF_GC_OBSERVER === '0') return;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // `startTime`/`duration` share the monotonic clock with performance.now(),
        // so they compare directly against the watchdog's window bounds.
        gcPauses.push({
          start: entry.startTime,
          end: entry.startTime + entry.duration,
          kind: (entry as { detail?: { kind?: number } }).detail?.kind ?? 0,
        });
      }
      if (gcPauses.length > GC_RING) gcPauses.splice(0, gcPauses.length - GC_RING);
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch {
    gcObserver = null; // Not fatal — classification just loses the `gc` source.
  }
}

export function stopGcObserver(): void {
  gcObserver?.disconnect();
  gcObserver = null;
  gcPauses.length = 0;
}

/** Total GC pause time overlapping [fromMono, toMono), in ms. */
export function gcMsIn(fromMono: number, toMono: number): number {
  let total = 0;
  for (const p of gcPauses) {
    const overlap = Math.min(p.end, toMono) - Math.max(p.start, fromMono);
    if (overlap > 0) total += overlap;
  }
  return total;
}

// ─── Synchronous busy accounting ─────────────────────────────────────────

interface SyncWindow {
  /** Measured synchronous ms in this window, counted at depth 0 only. */
  busyMs: number;
  /** Longest single section seen at any depth — the thing worth naming. */
  topSync?: { label: string; ms: number };
  /** Whether ANY instrumented work ran; distinguishes "idle" from "blind". */
  coverage: 'observed' | 'silent';
}

let busyMs = 0;
let topLabel: string | undefined;
let topMs = 0;
let observedAny = false;
let depth = 0;
const labels = new Set<string>();

function noteTop(label: string, ms: number): void {
  observedAny = true;
  if (ms > topMs) {
    topMs = ms;
    topLabel = label;
  }
  if (labels.size < MAX_SYNC_LABELS) labels.add(label);
}

/**
 * Open a synchronous section. MUST be closed in a `finally`. Nestable: only the
 * outermost contributes to `busyMs`, so a bus event wrapping ten SQL statements
 * counts once, not eleven.
 */
function enterSyncSection(label: string): { label: string; start: number; depth: number } {
  return { label, start: performance.now(), depth: depth++ };
}

function exitSyncSection(token: { label: string; start: number; depth: number }): void {
  const ms = performance.now() - token.start;
  depth = Math.max(0, depth - 1);
  if (token.depth === 0) busyMs += ms;
  noteTop(token.label, ms);
}

/** Report an already-measured synchronous leaf (e.g. one SQLite statement). */
export function noteSyncLeaf(label: string, ms: number): void {
  if (depth === 0) busyMs += ms; // Otherwise the enclosing section already counts it.
  noteTop(label, ms);
}

/** Convenience wrapper for a synchronous callback. */
function noteSyncSection<T>(label: string, fn: () => T): T {
  const token = enterSyncSection(label);
  try {
    return fn();
  } finally {
    exitSyncSection(token);
  }
}

/** Read and reset the accumulator. Called once per watchdog tick. */
export function takeSyncWindow(): SyncWindow {
  const out: SyncWindow = {
    busyMs,
    coverage: observedAny ? 'observed' : 'silent',
    ...(topLabel !== undefined ? { topSync: { label: topLabel, ms: topMs } } : {}),
  };
  busyMs = 0;
  topLabel = undefined;
  topMs = 0;
  observedAny = false;
  return out;
}

/** Diagnostic self-report, surfaced by `GET /api/admin/perf/freezes`. */
export function stallEvidenceInfo(): {
  eluAvailable: boolean;
  gcObserver: boolean;
  syncLabels: number;
} {
  return { eluAvailable: eluTrusted(), gcObserver: gcObserver !== null, syncLabels: labels.size };
}

/** Test seam. */
function resetStallEvidence(): void {
  eluAvailable = null;
  eluProbes = 0;
  eluWarned = false;
  gcPauses.length = 0;
  busyMs = 0;
  topLabel = undefined;
  topMs = 0;
  observedAny = false;
  depth = 0;
  labels.clear();
}
