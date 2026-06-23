/**
 * Renderer-side vitals: main-thread freezes captured via PerformanceObserver
 * into a small ring buffer. Module-level singleton — starts on first call and
 * keeps observing while the app lives, so the panel shows history from before
 * it was opened.
 *
 * Prefers **Long Animation Frames** (LoAF, Chrome/Electron 123+): unlike the
 * legacy `longtask` API (which only gives a duration + a useless "self" name),
 * LoAF attributes the block to the actual blocking SCRIPTS — sourceURL +
 * invoker — so the panel can say WHICH code froze the UI (JsonTree.tsx,
 * Markdown, Monaco…). Falls back to `longtask` where LoAF is unavailable.
 */

export interface LongTaskRow {
  at: number;
  durationMs: number;
  /** Human label: the dominant script's invoker/url (LoAF) or entry name (longtask). */
  name: string;
  /** LoAF only: the blocking script's source URL — the "what froze the UI". */
  script?: string;
  kind: 'loaf' | 'longtask';
}

interface LoafScript {
  sourceURL?: string;
  invoker?: string;
  invokerType?: string;
  duration: number;
}
interface LoafEntry extends PerformanceEntry {
  scripts?: LoafScript[];
}

const MAX_ROWS = 50;
const longTasks: LongTaskRow[] = [];
let started = false;
let activeObserver: PerformanceObserver | undefined;

function pushRow(row: LongTaskRow): void {
  longTasks.push(row);
  if (longTasks.length > MAX_ROWS) longTasks.splice(0, longTasks.length - MAX_ROWS);
}

/**
 * Map one Long-Animation-Frame entry to a row: the dominant (longest-duration)
 * blocking script names the culprit. Pure + exported so the user-facing "which
 * script froze the UI" attribution is unit-tested (mirrors the main-process
 * `attributeStall`).
 */
export function loafToRow(e: LoafEntry, at = Date.now()): LongTaskRow {
  let top: LoafScript | undefined;
  for (const s of e.scripts ?? []) {
    if (!top || s.duration > top.duration) top = s;
  }
  return {
    at,
    durationMs: Math.round(e.duration),
    name: top?.invoker || top?.sourceURL || e.name || 'animation-frame',
    script: top?.sourceURL || undefined,
    kind: 'loaf',
  };
}

export function ensureRendererVitals(): void {
  if (started || typeof PerformanceObserver === 'undefined') return;
  started = true;

  const supported = PerformanceObserver.supportedEntryTypes;
  const useLoaf = Array.isArray(supported) && supported.includes('long-animation-frame');

  const observeLongtask = (): void => {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          pushRow({ at: Date.now(), durationMs: Math.round(entry.duration), name: entry.name, kind: 'longtask' });
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
      activeObserver = obs;
    } catch {
      // Neither API supported — panel shows an empty list.
    }
  };

  if (!useLoaf) {
    observeLongtask();
    return;
  }

  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) pushRow(loafToRow(entry as LoafEntry));
    });
    obs.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit);
    activeObserver = obs;
  } catch {
    observeLongtask();
  }
}

/** Disconnect the renderer-vitals observer (best-effort). Lets a fresh
 *  `ensureRendererVitals()` re-observe on the next panel mount; the bounded
 *  `longTasks` ring is kept so prior history survives a close/reopen. */
export function stopRendererVitals(): void {
  if (activeObserver) {
    try {
      activeObserver.disconnect();
    } catch {
      // disconnect is best-effort.
    }
    activeObserver = undefined;
  }
  started = false;
}

export function getLongTasks(): LongTaskRow[] {
  return [...longTasks].reverse(); // newest first
}

/** Clear the renderer-side ring so the Freezes panel "Reset" empties BOTH
 *  the main-process freezes and the renderer LoAF rows. */
export function clearLongTasks(): void {
  longTasks.length = 0;
}
