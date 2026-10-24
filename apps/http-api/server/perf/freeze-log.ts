/**
 * Freeze recorder — catches MAIN-thread stalls (the "trava TODAS as telas"
 * symptom). The in-process http-api shares the Electron main event loop, so a
 * single synchronous handler or a GC pause freezes every renderer at once.
 *
 * The WATCHDOG detects a stall (its own wakeup arrives late on the monotonic
 * clock), then CLASSIFIES it by the main loop's REAL utilization during the
 * window (`eventLoopUtilization` — per-main-thread, unlike process-wide
 * `cpuUsage` which would count worker_threads):
 *   - loop was BUSY (active ≈ stall) → a genuine main-thread block (a sync
 *     handler or a GC pause). Attributed to the in-flight handler whose
 *     lifetime ≈ the stall, else `event-loop`.
 *   - libuv was mostly IDLE (active ≪ stall) → no synchronous Node handler can
 *     be attributed. In Electron this can still be native Chromium/Electron
 *     work on the browser thread, OS descheduling/contention, or suspend.
 * The perf panel's OWN routes (`/api/admin/perf/*`) are excluded from
 * attribution so the observer never appears as the culprit.
 *
 * Renderer freezes (Long Animation Frames) are recorded by the dashboard and
 * shown in the same panel; this module is the main-process half. In-memory,
 * reset via the perf route.
 */
import { performance } from 'node:perf_hooks';
import { currentPersistentPerfRun, recordPersistentFreeze } from './persistent-diagnostics.js';
import {
  eluActiveMs,
  gcMsIn,
  startGcObserver,
  stopGcObserver,
  takeSyncWindow,
} from './stall-evidence.js';
import {
  enterOffloopActivity,
  enterOffloopHandler,
  exitOffloopActivity,
  exitOffloopHandler,
  heartbeatOffloopWatchdog,
  startOffloopWatchdog,
  stopOffloopWatchdog,
} from './offloop-watchdog.js';

type FreezeSource =
  | 'handler'
  | 'background'
  | 'event-loop'
  | 'renderer'
  | 'starved'
  | 'offloop'
  /** A V8 GC pause covered the stall — proven by PerformanceObserver, not guessed. */
  | 'gc'
  /** An instrumented synchronous section covered the stall; `channel` names it. */
  | 'sync'
  /**
   * Nothing instrumented ran AND the runtime cannot report loop utilization, so
   * we genuinely do not know. Distinct from `starved`, which is a positive
   * claim that the loop was idle and requires trustworthy ELU to make.
   */
  | 'unattributed';

interface FreezeEvent {
  at: number;
  source: FreezeSource;
  /** IPC channel (handler), sync-section label, or script URL (renderer). */
  channel?: string;
  durationMs: number;
  detail?: string;
  /** Retained for wire compatibility with older grouped rows. New rows are raw. */
  count?: number;
  wallLateMs?: number;
  windowMs?: number;
  /** `null` when the runtime cannot report it — never a misleading 0. */
  activeMs?: number | null;
  busyFraction?: number | null;
  /** Measured synchronous main-thread ms in the window (self-reported). */
  busyMs?: number;
  /** V8 GC pause ms overlapping the window. */
  gcMs?: number;
  /** Label of the longest instrumented sync section in the window. */
  topSyncLabel?: string;
  /** Whether `eventLoopUtilization()` is trustworthy in this runtime. */
  eluAvailable?: boolean;
  /** `silent` = no instrumented work ran, so absence of busy time proves nothing. */
  coverage?: 'observed' | 'silent';
  /**
   * Main-process RSS at detection, MB. A `starved` stall means the loop was
   * IDLE while the clock jumped — the usual cause is the OS trimming/paging a
   * large working set, so RSS is the first thing to look at. Stamped here so
   * the correlation is in the journal instead of being reconstructed by hand
   * against the nearest `sample` row.
   */
  rssMB?: number;
  /** RSS change since the last healthy tick, MB. Positive = grew during the stall. */
  rssDeltaMB?: number;
  /**
   * `offloop` only. Stable id for ONE hang; the worker watchdog re-reports a
   * still-ongoing stall every `repeatMs` with a growing `durationMs`, so rows
   * sharing a `hangId` describe the same stall and must be collapsed (take the
   * max `durationMs`) rather than summed. Aggregating without this over-counts
   * total freeze time roughly 2x.
   */
  hangId?: string;
  /** 1-based index of this report within its `hangId`. */
  reportSeq?: number;
}

/** NaN-safe numeric env: an operator-set garbage value falls back instead of
 *  becoming NaN (which would disable a guard or spin setInterval at ~0ms). */
function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const MAX_EVENTS = 120;
const FREEZE_THRESHOLD_MS = numEnv('MCP_FREEZE_THRESHOLD_MS', 200);
const WATCHDOG_INTERVAL_MS = numEnv('MCP_FREEZE_WATCHDOG_MS', 250);
/** Below this fraction of the watchdog WINDOW (interval + stall overshoot) spent
 *  ACTIVE, the main loop was idle/parked → starvation/await, not a sync block.
 *  Kept modest (0.35) so a genuine short block whose pre-stall slice was idle
 *  still reads busy, while a long await/contention stall reads starved. */
const BUSY_FRACTION = numEnv('MCP_FREEZE_BUSY_FRACTION', 0.35);
/** The perf panel's own routes — never blame the observer for a stall. */
function isObserverChannel(channel: string | undefined): boolean {
  return !!channel && channel.includes('/api/admin/perf/');
}

const events: FreezeEvent[] = [];

function recordFreeze(e: Omit<FreezeEvent, 'at'> & { at?: number }): void {
  const at = e.at ?? Date.now();
  const event: FreezeEvent = {
    at,
    source: e.source,
    channel: e.channel,
    durationMs: Math.round(e.durationMs),
    detail: e.detail,
    count: 1,
    wallLateMs: e.wallLateMs,
    windowMs: e.windowMs,
    activeMs: e.activeMs,
    busyFraction: e.busyFraction,
    busyMs: e.busyMs,
    gcMs: e.gcMs,
    topSyncLabel: e.topSyncLabel,
    eluAvailable: e.eluAvailable,
    coverage: e.coverage,
    rssMB: e.rssMB,
    rssDeltaMB: e.rssDeltaMB,
  };
  // Preserve every detection. The old implementation merged any later
  // `starved` row even when healthy ticks occurred between them, making ×N
  // look like one continuous freeze and discarding its real timestamps.
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  recordPersistentFreeze(event);
}

/** Most recent first. */
export function freezeSnapshot(): FreezeEvent[] {
  return [...events].reverse();
}

export function resetFreezes(): void {
  events.length = 0;
}

// ─── In-flight handler registry ──────────────────────────────────────────
// Map keyed by a monotonic id so concurrent/re-entrant handlers each get a
// slot; the SUSPECT is the most-recently-entered still-active one (the handler
// running synchronously when the loop blocked — earlier entries are parked in
// their own awaits, which don't block).

let nextId = 1;
interface InFlightEntry { channel: string; at: number; kind: 'handler' | 'background'; }
const inFlight = new Map<number, InFlightEntry>();

export function enterInFlight(channel: string): number {
  const id = nextId++;
  const at = Date.now();
  inFlight.set(id, { channel, at, kind: 'handler' });
  enterOffloopHandler(id, channel, at);
  return id;
}

export function exitInFlight(id: number): void {
  inFlight.delete(id);
  exitOffloopHandler(id);
}

/**
 * Register main-process work that is not an HTTP/IPC handler (for example a
 * worker spawn or eviction). The returned token must be released in `finally`.
 */
export function enterBackgroundActivity(label: string): number {
  const id = nextId++;
  const at = Date.now();
  inFlight.set(id, { channel: label, at, kind: 'background' });
  enterOffloopActivity(id, label, at, 'background');
  return id;
}

export function exitBackgroundActivity(id: number): void {
  const entry = inFlight.get(id);
  inFlight.delete(id);
  exitOffloopActivity(id);
  if (!entry || entry.kind !== 'background') return;
  const durationMs = Date.now() - entry.at;
  if (durationMs >= FREEZE_THRESHOLD_MS * 0.5) {
    lastExit = { channel: entry.channel, at: Date.now(), durationMs, kind: 'background' };
  }
}

/** The most-recently-entered still-active handler (insertion-ordered Map). */
function currentInFlight(): InFlightEntry | undefined {
  let last: InFlightEntry | undefined;
  for (const e of inFlight.values()) last = e;
  return last;
}

// A sync-blocking handler usually RETURNS before the post-block watchdog tick
// fires (the timer is queued behind the handler), so `currentInFlight()` is
// already null by then. Remember the last heavy exit so the watchdog can still
// pin the freeze on it when its duration + recency match the stall.
let lastExit: {
  channel: string;
  at: number;
  durationMs: number;
  kind: 'handler' | 'background';
} | null = null;

export function noteExit(channel: string, durationMs: number): void {
  if (durationMs >= FREEZE_THRESHOLD_MS * 0.5) {
    lastExit = { channel, at: Date.now(), durationMs, kind: 'handler' };
  }
}

// ─── Attribution (pure, unit-tested) ─────────────────────────────────────

interface StallAttribution {
  source: Exclude<FreezeSource, 'renderer' | 'offloop'>;
  channel?: string;
}

/** What the watchdog measured over one window. See `stall-evidence.ts`. */
export interface StallEvidence {
  /** Overshoot beyond the intended watchdog interval. */
  monoLate: number;
  /** True inter-tick gap — the window every other figure spans. */
  windowMs: number;
  /** Measured synchronous main-thread ms (self-reported by instrumentation). */
  busyMs: number;
  /** Longest instrumented sync section in the window. */
  topSync?: { label: string; ms: number };
  /** V8 GC pause ms overlapping the window. */
  gcMs: number;
  /** `null` when the runtime cannot report it (Electron main) — NOT zero. */
  eluActiveMs: number | null;
  /** `silent` = nothing instrumented ran, so `busyMs === 0` proves nothing. */
  coverage: 'observed' | 'silent';
}

/**
 * Decide what a detected stall means. Pure (only reads module constants) so
 * it's unit-testable.
 *
 * The ordering encodes what we can actually PROVE, strongest evidence first:
 * a GC pause is observed directly; measured sync time names a real blocker;
 * ELU is consulted only where it works. The critical invariant is the tail —
 * `starved` asserts the loop was idle, so it requires trustworthy ELU. Without
 * it the honest answer is `unattributed`. Returning `starved` on `activeMs: 0`
 * from an ELU that always returns 0 is exactly the bug this replaced: it
 * labelled 100% of stalls `starved` and made every other branch unreachable.
 */
export function attributeStall(
  ev: StallEvidence,
  now: number,
  inFlight: { channel: string; at: number; kind?: 'handler' | 'background' } | undefined,
  lastExit: {
    channel: string;
    at: number;
    durationMs: number;
    kind?: 'handler' | 'background';
  } | null,
): StallAttribution {
  const { monoLate, windowMs, busyMs, topSync, gcMs, eluActiveMs: elu } = ev;
  // Guard: no window to reason about (also prevents divide-by-zero).
  if (monoLate <= 0 || windowMs <= 0) return { source: 'starved' };

  // 1. A GC pause covering half the stall explains it outright.
  if (gcMs >= Math.max(50, monoLate * 0.5)) return { source: 'gc' };

  // 2. Instrumented synchronous work covering the window → a real block.
  if (busyMs / windowMs >= BUSY_FRACTION) {
    if (topSync && topSync.ms >= monoLate * 0.5 && !isObserverChannel(topSync.label)) {
      return { source: 'sync', channel: topSync.label };
    }
    // Prefer the in-flight handler whose whole lifetime ≈ this stall (ran sync
    // the whole window); else a heavy handler that just returned. NEVER the
    // observer (the perf panel's own routes).
    if (inFlight && !isObserverChannel(inFlight.channel) && now - inFlight.at <= monoLate + WATCHDOG_INTERVAL_MS) {
      return { source: inFlight.kind === 'background' ? 'background' : 'handler', channel: inFlight.channel };
    }
    if (
      lastExit && !isObserverChannel(lastExit.channel) &&
      now - lastExit.at <= WATCHDOG_INTERVAL_MS + 100 &&
      Math.abs(lastExit.durationMs - monoLate) <= monoLate * 0.5
    ) {
      return { source: lastExit.kind === 'background' ? 'background' : 'handler', channel: lastExit.channel };
    }
    return { source: 'event-loop' };
  }

  // 3. Where ELU works, fall back to the original utilization test.
  if (elu !== null) {
    if (elu / windowMs >= BUSY_FRACTION) return { source: 'event-loop' };
    // Loop measurably IDLE across the window → an await window or an OS
    // deschedule under contention. The label is EARNED here.
    return { source: 'starved' };
  }

  // 4. No GC, no observed sync work, and no trustworthy utilization signal.
  return { source: 'unattributed' };
}

function detailFor(source: StallAttribution['source'], coverage: 'observed' | 'silent'): string | undefined {
  if (source === 'background') return 'Main loop was busy during a registered background activity';
  if (source === 'event-loop') return 'Sync non-IPC turn (main loop was measurably busy)';
  if (source === 'gc') return 'V8 garbage collection pause covered the stall (observed directly)';
  if (source === 'sync') return 'An instrumented synchronous section blocked the main thread';
  if (source === 'starved') {
    return 'Node/libuv tick delayed while the loop was measurably idle — native Electron/Chromium work, OS contention/deschedule, or suspend';
  }
  if (source === 'unattributed') {
    return (
      'Main-thread JS was not observed running (no instrumented sync work, no GC) and eventLoopUtilization ' +
      'is unavailable in this runtime, so idleness cannot be asserted. The block is either outside Node ' +
      '(native Electron/Chromium browser-thread work, a blocking OS call) or in an uninstrumented code path' +
      (coverage === 'silent' ? ' — nothing instrumented ran at all in this window.' : '.')
    );
  }
  return undefined;
}

// ─── Watchdog ────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let expectedWall = 0;
let lastMono = 0;
let eluPrev: ReturnType<typeof performance.eventLoopUtilization> | undefined;
/** RSS at the last healthy tick, MB — the baseline for a freeze's `rssDeltaMB`. */
let lastHealthyRssMB = 0;
let rssTick = 0;

/** `process.memoryUsage.rss()` is the cheap variant (no full stats object). */
function currentRssMB(): number {
  return Math.round((process.memoryUsage.rss() / 1024 / 1024) * 10) / 10;
}

/** Start the main-loop stall watchdog. Idempotent. */
export function startFreezeWatchdog(): void {
  if (timer) return;
  const persistedRun = currentPersistentPerfRun();
  if (persistedRun) startOffloopWatchdog(persistedRun.path);
  startGcObserver();
  expectedWall = Date.now() + WATCHDOG_INTERVAL_MS;
  lastMono = performance.now();
  eluPrev = typeof performance.eventLoopUtilization === 'function' ? performance.eventLoopUtilization() : undefined;
  lastHealthyRssMB = currentRssMB();
  rssTick = 0;
  timer = setInterval(() => {
    heartbeatOffloopWatchdog();
    const now = Date.now();
    const mono = performance.now();
    const wallLate = now - expectedWall;
    const windowMs = mono - lastMono;                 // true inter-tick gap
    const monoLate = windowMs - WATCHDOG_INTERVAL_MS; // overshoot beyond the intended interval
    const windowStartMono = lastMono;
    lastMono = mono;
    expectedWall = now + WATCHDOG_INTERVAL_MS;
    // Self-reported synchronous time over the SAME window monoLate/windowMs
    // span. Must be drained EVERY tick (healthy ones included) or a stall would
    // inherit busy time accumulated over the preceding healthy seconds.
    const sync = takeSyncWindow();
    const eluNow = typeof performance.eventLoopUtilization === 'function'
      ? performance.eventLoopUtilization()
      : undefined;
    const elu = eluNow ? eluActiveMs(eluPrev, eluNow) : null;
    eluPrev = eluNow;
    if (monoLate < FREEZE_THRESHOLD_MS) {
      // Healthy tick — refresh the RSS baseline, throttled to ~1/s so the
      // watchdog itself stays cheap at a 250ms interval.
      if (++rssTick >= 4) {
        rssTick = 0;
        lastHealthyRssMB = currentRssMB();
      }
      return;
    }
    // Wall jumped far beyond the monotonic elapsed → NTP step / wake-from-sleep.
    if (wallLate - monoLate > 5_000) return;
    const rssMB = currentRssMB();
    const baselineRssMB = lastHealthyRssMB;
    lastHealthyRssMB = rssMB;
    // GC entries and this timer both drain on the same loop turn with NO
    // guaranteed order, so a pause that ended inside the window may not have
    // been delivered yet. One setImmediate lets the observer flush first. The
    // off-loop worker journal remains the durable backstop if the process dies
    // in that gap — which is already its documented contract.
    setImmediate(() => {
      const ev: StallEvidence = {
        monoLate,
        windowMs,
        busyMs: sync.busyMs,
        topSync: sync.topSync,
        gcMs: gcMsIn(windowStartMono, mono),
        eluActiveMs: elu,
        coverage: sync.coverage,
      };
      const { source, channel } = attributeStall(ev, now, currentInFlight(), lastExit);
      recordFreeze({
        at: now,
        source,
        channel,
        durationMs: Math.round(monoLate),
        detail: detailFor(source, ev.coverage),
        wallLateMs: Math.round(wallLate),
        windowMs: Math.round(windowMs),
        // `null`, not 0, when the runtime cannot report it — a 0 here is what
        // made every stall look idle and read as `starved`.
        activeMs: elu === null ? null : Math.round(elu * 10) / 10,
        busyFraction: elu === null ? null : Math.round((elu / Math.max(1, windowMs)) * 1000) / 1000,
        busyMs: Math.round(ev.busyMs * 10) / 10,
        gcMs: Math.round(ev.gcMs * 10) / 10,
        topSyncLabel: sync.topSync?.label,
        eluAvailable: elu !== null,
        coverage: ev.coverage,
        rssMB,
        ...(baselineRssMB > 0 ? { rssDeltaMB: Math.round((rssMB - baselineRssMB) * 10) / 10 } : {}),
      });
    });
  }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
}

export function stopFreezeWatchdog(): Promise<void> {
  stopGcObserver();
  if (timer) {
    clearInterval(timer);
    timer = null;
    expectedWall = 0;
    lastMono = 0;
    eluPrev = undefined;
    lastHealthyRssMB = 0;
    rssTick = 0;
  }
  return stopOffloopWatchdog();
}

export function freezeThresholdMs(): number {
  return FREEZE_THRESHOLD_MS;
}
