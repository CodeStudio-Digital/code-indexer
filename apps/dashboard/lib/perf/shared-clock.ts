/**
 * ONE timer for every "elapsed seconds" readout in the app.
 *
 * The dashboard had ~8 components each running their own `setInterval(…, 1000)`
 * just to re-render a `Xs` label: every running tool call, every activity line,
 * the stuck banner, the preflight indicator, the active-processes list, the
 * voice recorder. A busy turn with 12 concurrent tool calls meant 12 timers and
 * 12 independent React renders per second, and they all kept firing while the
 * Electron window was minimized or the tab hidden — pure background CPU.
 *
 * This module keeps a single interval, shared by every subscriber:
 *
 *  - **Lazy**: the timer only exists while at least one component subscribes,
 *    so an idle session pays nothing (same guarantee the per-component effects
 *    gave, but now amortized).
 *  - **Visibility-aware**: the interval is cleared while the document is
 *    hidden and restarted on `visibilitychange`, with an immediate re-sync so
 *    the label is correct the instant the window comes back — a hidden window
 *    costs literally zero wakeups.
 *  - **Two lanes**: a 1 Hz lane for `Xs` labels and a 4 Hz lane for the
 *    sub-second readouts (voice recorder). Each lane has its own timer, still
 *    at most one per lane process-wide.
 *
 * Read it with `useNow()` / `useNowFast()`. Both return a `Date.now()`
 * millisecond stamp that only changes on a tick, so `useSyncExternalStore`
 * sees a stable snapshot between ticks (returning a fresh `Date.now()` from
 * `getSnapshot` would spin React forever).
 */
import { useSyncExternalStore } from 'react';

type Listener = () => void;

interface Lane {
  readonly intervalMs: number;
  now: number;
  timer: ReturnType<typeof setInterval> | null;
  readonly listeners: Set<Listener>;
}

function makeLane(intervalMs: number): Lane {
  return { intervalMs, now: Date.now(), timer: null, listeners: new Set() };
}

const slowLane = makeLane(1_000);
const fastLane = makeLane(250);
const lanes = [slowLane, fastLane];

/** Document-hidden is checked lazily so this module also works under SSR/jsdom. */
function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function tick(lane: Lane): void {
  lane.now = Date.now();
  for (const listener of lane.listeners) listener();
}

function startLane(lane: Lane): void {
  if (lane.timer !== null || lane.listeners.size === 0 || isHidden()) return;
  lane.timer = setInterval(() => tick(lane), lane.intervalMs);
}

function stopLane(lane: Lane): void {
  if (lane.timer === null) return;
  clearInterval(lane.timer);
  lane.timer = null;
}

let visibilityBound = false;

function onVisibilityChange(): void {
  if (isHidden()) {
    for (const lane of lanes) stopLane(lane);
    return;
  }
  // Coming back from hidden: publish the real time BEFORE restarting the
  // timers so a window restored after 10 minutes shows the correct elapsed
  // value on the first paint instead of one interval later.
  for (const lane of lanes) {
    if (lane.listeners.size === 0) continue;
    tick(lane);
    startLane(lane);
  }
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function subscribeLane(lane: Lane, listener: Listener): () => void {
  bindVisibility();
  lane.listeners.add(listener);
  // First subscriber after an idle period may be reading a stale `now` (the
  // lane keeps its last value once the timer stops). Refresh it so the very
  // first render is accurate without waiting a full interval.
  if (lane.listeners.size === 1) lane.now = Date.now();
  startLane(lane);
  return () => {
    lane.listeners.delete(listener);
    if (lane.listeners.size === 0) stopLane(lane);
  };
}

/** Subscribe to the 1 Hz lane. Returns the unsubscribe function. */
export const subscribeNow = (listener: Listener) => subscribeLane(slowLane, listener);
/** Subscribe to the 4 Hz lane. Returns the unsubscribe function. */
export const subscribeNowFast = (listener: Listener) => subscribeLane(fastLane, listener);
/** Last published 1 Hz stamp — stable between ticks. */
export const readNow = () => slowLane.now;
/** Last published 4 Hz stamp — stable between ticks. */
export const readNowFast = () => fastLane.now;

// A disabled subscriber still has to hand React a *stable* snapshot, otherwise
// every parent render would look like a store change. This frozen module-init
// stamp keeps the hook order intact while contributing no listener, no timer
// and no re-render. Callers gate on the same condition they pass as `enabled`
// (`running ? now - startedAt : …`), so the frozen value is never displayed.
const DISABLED_NOW = Date.now();
const subscribeNever = () => () => undefined;
const getDisabled = () => DISABLED_NOW;

/**
 * Current time, refreshed once per second by the shared clock. Components that
 * only render an elapsed-seconds label should use this instead of their own
 * interval — `enabled: false` unsubscribes entirely (a finished tool call must
 * not hold the timer alive).
 */
export function useNow(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribeNow : subscribeNever,
    enabled ? readNow : getDisabled,
    enabled ? readNow : getDisabled,
  );
}

/** Same contract as `useNow`, refreshed 4×/s for sub-second readouts. */
export function useNowFast(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribeNowFast : subscribeNever,
    enabled ? readNowFast : getDisabled,
    enabled ? readNowFast : getDisabled,
  );
}

/** Test-only: tear down timers/listeners so a suite can't leak between files. */
export function __resetSharedClockForTests(): void {
  for (const lane of lanes) {
    stopLane(lane);
    lane.listeners.clear();
    lane.now = Date.now();
  }
}

/** Test-only: how many timers the shared clock currently owns (0, 1 or 2). */
export function __sharedClockTimerCount(): number {
  return lanes.filter((lane) => lane.timer !== null).length;
}
