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
  enterOffloopHandler,
  exitOffloopHandler,
  heartbeatOffloopWatchdog,
  startOffloopWatchdog,
  stopOffloopWatchdog,
} from './offloop-watchdog.js';

export interface FreezeEvent {
  at: number;
  source: 'handler' | 'event-loop' | 'renderer' | 'starved' | 'offloop';
  /** IPC channel (handler) or script URL (renderer); absent for GC/starved. */
  channel?: string;
  durationMs: number;
  detail?: string;
  /** Retained for wire compatibility with older grouped rows. New rows are raw. */
  count?: number;
  wallLateMs?: number;
  windowMs?: number;
  activeMs?: number;
  busyFraction?: number;
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
interface InFlightEntry { channel: string; at: number; }
const inFlight = new Map<number, InFlightEntry>();

export function enterInFlight(channel: string): number {
  const id = nextId++;
  const at = Date.now();
  inFlight.set(id, { channel, at });
  enterOffloopHandler(id, channel, at);
  return id;
}

export function exitInFlight(id: number): void {
  inFlight.delete(id);
  exitOffloopHandler(id);
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
let lastExit: { channel: string; at: number; durationMs: number } | null = null;

export function noteExit(channel: string, durationMs: number): void {
  if (durationMs >= FREEZE_THRESHOLD_MS * 0.5) {
    lastExit = { channel, at: Date.now(), durationMs };
  }
}

// ─── Attribution (pure, unit-tested) ─────────────────────────────────────

interface StallAttribution {
  source: 'handler' | 'event-loop' | 'starved';
  channel?: string;
}

/**
 * Decide what a detected stall means, given how ACTIVE the main loop was over
 * the watchdog WINDOW (`activeMs` from eventLoopUtilization, `windowMs` the same
 * inter-tick gap the ELU delta spans — numerator and denominator MUST share the
 * window, else pre-stall busy time inflates the ratio against 'starved'). Pure
 * (only reads the module constants) so it's unit-testable.
 */
export function attributeStall(
  monoLate: number,
  activeMs: number,
  windowMs: number,
  now: number,
  inFlight: { channel: string; at: number } | undefined,
  lastExit: { channel: string; at: number; durationMs: number } | null,
): StallAttribution {
  // Loop mostly IDLE across the window → an await window or an OS deschedule
  // under CPU contention, NOT a main-thread sync block. Don't pin a handler.
  if (monoLate <= 0 || windowMs <= 0 || activeMs / windowMs < BUSY_FRACTION) return { source: 'starved' };
  // Genuine main-thread block. Prefer the in-flight handler whose whole
  // lifetime ≈ this stall (ran sync the whole window); else a heavy handler
  // that just returned. NEVER the observer (perf panel's own routes).
  if (inFlight && !isObserverChannel(inFlight.channel) && now - inFlight.at <= monoLate + WATCHDOG_INTERVAL_MS) {
    return { source: 'handler', channel: inFlight.channel };
  }
  if (
    lastExit && !isObserverChannel(lastExit.channel) &&
    now - lastExit.at <= WATCHDOG_INTERVAL_MS + 100 &&
    Math.abs(lastExit.durationMs - monoLate) <= monoLate * 0.5
  ) {
    return { source: 'handler', channel: lastExit.channel };
  }
  return { source: 'event-loop' };
}

function detailFor(source: StallAttribution['source']): string | undefined {
  if (source === 'event-loop') return 'GC / sync non-IPC turn (main loop was busy)';
  if (source === 'starved') {
    return 'Node/libuv tick delayed while mostly idle — native Electron/Chromium work, OS contention/deschedule, or suspend; no JS handler attributed';
  }
  return undefined;
}

// ─── Watchdog ────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let expectedWall = 0;
let lastMono = 0;
let eluPrev: ReturnType<typeof performance.eventLoopUtilization> | undefined;

/** Start the main-loop stall watchdog. Idempotent. */
export function startFreezeWatchdog(): void {
  if (timer) return;
  const persistedRun = currentPersistentPerfRun();
  if (persistedRun) startOffloopWatchdog(persistedRun.path);
  expectedWall = Date.now() + WATCHDOG_INTERVAL_MS;
  lastMono = performance.now();
  eluPrev = typeof performance.eventLoopUtilization === 'function' ? performance.eventLoopUtilization() : undefined;
  timer = setInterval(() => {
    heartbeatOffloopWatchdog();
    const now = Date.now();
    const mono = performance.now();
    const wallLate = now - expectedWall;
    const windowMs = mono - lastMono;                 // true inter-tick gap = the ELU window
    const monoLate = windowMs - WATCHDOG_INTERVAL_MS; // overshoot beyond the intended interval
    lastMono = mono;
    expectedWall = now + WATCHDOG_INTERVAL_MS;
    // Active ms over the SAME window the monoLate/windowMs span — so busyFrac
    // (activeMs/windowMs in attributeStall) is comparable. Fallback (no ELU) =
    // fully busy = legacy behaviour.
    let activeMs = windowMs;
    if (typeof performance.eventLoopUtilization === 'function') {
      const eluNow = performance.eventLoopUtilization();
      if (eluPrev) activeMs = performance.eventLoopUtilization(eluNow, eluPrev).active;
      eluPrev = eluNow;
    }
    if (monoLate < FREEZE_THRESHOLD_MS) return;
    // Wall jumped far beyond the monotonic elapsed → NTP step / wake-from-sleep.
    if (wallLate - monoLate > 5_000) return;
    const { source, channel } = attributeStall(monoLate, activeMs, windowMs, now, currentInFlight(), lastExit);
    recordFreeze({
      at: now,
      source,
      channel,
      durationMs: Math.round(monoLate),
      detail: detailFor(source),
      wallLateMs: Math.round(wallLate),
      windowMs: Math.round(windowMs),
      activeMs: Math.round(activeMs * 10) / 10,
      busyFraction: Math.round((activeMs / Math.max(1, windowMs)) * 1000) / 1000,
    });
  }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
}

export function stopFreezeWatchdog(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
    expectedWall = 0;
    lastMono = 0;
    eluPrev = undefined;
  }
  return stopOffloopWatchdog();
}

export function freezeThresholdMs(): number {
  return FREEZE_THRESHOLD_MS;
}
