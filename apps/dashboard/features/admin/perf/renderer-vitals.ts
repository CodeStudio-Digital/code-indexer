/**
 * Renderer-side vitals: long tasks (main-thread blocks >50ms) and slow
 * event-handler entries, captured via PerformanceObserver into a small
 * ring buffer. Module-level singleton — starts on first call and keeps
 * observing while the app lives, so the panel shows history from before
 * it was opened.
 */

export interface LongTaskRow {
  at: number;
  durationMs: number;
  /** PerformanceEntry name — usually "self" or the container attribution. */
  name: string;
}

const MAX_ROWS = 50;
const longTasks: LongTaskRow[] = [];
let started = false;

export function ensureRendererVitals(): void {
  if (started || typeof PerformanceObserver === 'undefined') return;
  started = true;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({
          at: Date.now(),
          durationMs: Math.round(entry.duration),
          name: entry.name,
        });
      }
      if (longTasks.length > MAX_ROWS) longTasks.splice(0, longTasks.length - MAX_ROWS);
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask not supported — panel shows an empty list.
  }
}

export function getLongTasks(): LongTaskRow[] {
  return [...longTasks].reverse(); // newest first
}
