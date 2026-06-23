/**
 * Trailing throttle for semantic-token requests, keyed per model URI.
 *
 * Monaco re-requests semantic tokens after every content change; even with
 * the compute off the main process it's still one RPC + one TS-program
 * query per keystroke. Policy: the first call in a quiet window runs
 * immediately (fresh colors on open/switch); calls landing inside the
 * window collapse into ONE trailing run whose promise they all share.
 */

const WINDOW_MS = 500;

interface Slot {
  lastRunAt: number;
  pending: Promise<unknown> | null;
}

const slots = new Map<string, Slot>();

export function throttledPerKey<T>(key: string, run: () => Promise<T>): Promise<T> {
  let slot = slots.get(key);
  if (!slot) {
    slot = { lastRunAt: 0, pending: null };
    slots.set(key, slot);
  }
  const now = performance.now();
  if (slot.pending) return slot.pending as Promise<T>;
  if (now - slot.lastRunAt >= WINDOW_MS) {
    slot.lastRunAt = now;
    return run();
  }
  const wait = WINDOW_MS - (now - slot.lastRunAt);
  const s = slot;
  s.pending = new Promise<T>((resolve) => {
    setTimeout(() => {
      s.pending = null;
      s.lastRunAt = performance.now();
      resolve(run());
    }, wait);
  });
  return s.pending as Promise<T>;
}

/** Drop a model's slot (model disposed) so the map doesn't grow unbounded. */
export function clearThrottleKey(key: string): void {
  slots.delete(key);
}
