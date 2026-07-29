/**
 * Unit tests for the app-wide shared clock (lib/perf/shared-clock.ts).
 *
 * The invariants that matter here are structural, not visual: N subscribers
 * must share ONE timer, a fully-unsubscribed lane must own ZERO timers, and a
 * hidden document must not tick at all. Asserting those directly is what stops
 * the app from drifting back to one `setInterval` per elapsed-seconds label.
 *
 * The suite exercises the non-React core (`subscribeNow` / `readNow`), which is
 * exactly what `useNow` passes to `useSyncExternalStore` — no DOM renderer
 * needed in this node-environment test run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Minimal `document` stand-in: the clock only needs visibilityState + events. */
function installFakeDocument(): { setHidden: (hidden: boolean) => void } {
  const listeners = new Set<() => void>();
  let hidden = false;
  (globalThis as { document?: unknown }).document = {
    get visibilityState() {
      return hidden ? 'hidden' : 'visible';
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'visibilitychange') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'visibilitychange') listeners.delete(listener);
    },
  };
  return {
    setHidden: (next: boolean) => {
      hidden = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

// The module binds its visibilitychange handler once, on first subscribe, so the
// fake document has to exist BEFORE the module is evaluated. A fresh import per
// test keeps lane state from leaking between cases.
type Clock = typeof import('../shared-clock.js');

let clock: Clock;
let doc: { setHidden: (hidden: boolean) => void };

beforeEach(async () => {
  vi.useFakeTimers();
  doc = installFakeDocument();
  vi.resetModules();
  clock = await import('../shared-clock.js');
});

afterEach(() => {
  clock.__resetSharedClockForTests();
  delete (globalThis as { document?: unknown }).document;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared clock', () => {
  it('runs no timer until something subscribes', () => {
    expect(clock.__sharedClockTimerCount()).toBe(0);
  });

  it('serves many subscribers from a single 1 Hz timer', () => {
    const seen = [0, 0, 0];
    const disposers = seen.map((_, i) => clock.subscribeNow(() => { seen[i]++; }));

    expect(clock.__sharedClockTimerCount()).toBe(1);

    vi.advanceTimersByTime(3_000);
    expect(seen).toEqual([3, 3, 3]);

    for (const dispose of disposers) dispose();
    expect(clock.__sharedClockTimerCount()).toBe(0);
  });

  it('keeps the timer alive until the LAST subscriber leaves', () => {
    const offA = clock.subscribeNow(() => undefined);
    const offB = clock.subscribeNow(() => undefined);

    offA();
    expect(clock.__sharedClockTimerCount()).toBe(1);
    offB();
    expect(clock.__sharedClockTimerCount()).toBe(0);
  });

  it('advances the snapshot only on a tick, so React sees a stable value', () => {
    const off = clock.subscribeNow(() => undefined);

    const first = clock.readNow();
    expect(clock.readNow()).toBe(first); // no drift between renders

    vi.advanceTimersByTime(1_000);
    expect(clock.readNow()).toBeGreaterThan(first);
    off();
  });

  it('separates the 1 Hz and 4 Hz lanes', () => {
    let slowTicks = 0;
    let fastTicks = 0;
    const offSlow = clock.subscribeNow(() => { slowTicks++; });
    const offFast = clock.subscribeNowFast(() => { fastTicks++; });

    expect(clock.__sharedClockTimerCount()).toBe(2);
    vi.advanceTimersByTime(1_000);
    expect(slowTicks).toBe(1);
    expect(fastTicks).toBe(4);

    offSlow();
    expect(clock.__sharedClockTimerCount()).toBe(1); // fast lane survives alone
    offFast();
    expect(clock.__sharedClockTimerCount()).toBe(0);
  });

  it('stops ticking while the document is hidden and re-syncs on return', () => {
    let ticks = 0;
    const off = clock.subscribeNow(() => { ticks++; });
    const before = clock.readNow();

    doc.setHidden(true);
    expect(clock.__sharedClockTimerCount()).toBe(0); // hidden window → no wakeups
    vi.advanceTimersByTime(10_000);
    expect(ticks).toBe(0);

    doc.setHidden(false);
    // A window restored after a long pause must show the real elapsed time on
    // its first paint, so the lane republishes before restarting the timer.
    expect(ticks).toBe(1);
    expect(clock.readNow()).toBeGreaterThanOrEqual(before + 10_000);
    expect(clock.__sharedClockTimerCount()).toBe(1);
    off();
  });

  it('does not start a timer for a subscriber added while hidden', () => {
    doc.setHidden(true);
    const off = clock.subscribeNow(() => undefined);
    expect(clock.__sharedClockTimerCount()).toBe(0);

    doc.setHidden(false);
    expect(clock.__sharedClockTimerCount()).toBe(1);
    off();
  });
});
