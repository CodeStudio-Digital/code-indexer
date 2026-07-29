/**
 * Lifecycle owner for the OS process census.
 *
 * The census only runs while something is looking at it. The task manager
 * polls `snapshot()`, which starts the collector on first touch and stamps an
 * access time; a janitor stops the collector once nobody has asked for ~20s.
 * Closing the window (or just minimising it — `usePolling` pauses on
 * `visibilityState: hidden`) therefore costs zero processes and zero CPU,
 * which matters a lot on Windows where the collector is a resident PowerShell.
 */
import type { CensusFrame } from '@mcp/shared/utils/process-census/types.js';
import type { CensusSource, CensusStatus } from './census-source.js';
import { WindowsCensusSource } from './windows-source.js';
import { PosixCensusSource } from './posix-source.js';

const IDLE_STOP_MS = 20_000;
const JANITOR_MS = 10_000;
const DEFAULT_INTERVAL_MS = 2_000;

export interface CensusSnapshot {
  status: CensusStatus;
  /** Newest frame, or null while warming. */
  frame: CensusFrame | null;
  /** Delta operand for rate derivation. */
  previous: CensusFrame | null;
}

let source: CensusSource | null = null;
let janitor: ReturnType<typeof setInterval> | null = null;
let lastAccessAt = 0;
let activeIntervalMs = DEFAULT_INTERVAL_MS;

/** Seam for tests — swap in a fake collector without spawning anything. */
let factory: () => CensusSource = () =>
  (process.platform === 'win32' ? new WindowsCensusSource() : new PosixCensusSource());

export function setCensusSourceFactory(make: () => CensusSource): void {
  factory = make;
}

function startJanitor(): void {
  if (janitor) return;
  janitor = setInterval(() => {
    if (!source) return;
    if (Date.now() - lastAccessAt < IDLE_STOP_MS) return;
    source.stop();
    source = null;
    if (janitor) clearInterval(janitor);
    janitor = null;
  }, JANITOR_MS);
  janitor.unref?.();
}

/**
 * Read the census, starting the collector if needed.
 *
 * @param intervalMs how often the collector should sample. A change restarts
 *   the collector, which on Windows means paying the PowerShell boot again —
 *   acceptable because it only happens when the user picks a new refresh rate.
 *   OMIT it for reads that are not the polling loop (the kill endpoint
 *   re-deriving the tree): passing a default there would fight the rate the
 *   user actually chose and restart the collector on every kill.
 */
export function censusSnapshot(intervalMs?: number): CensusSnapshot {
  lastAccessAt = Date.now();

  if (intervalMs !== undefined) {
    const wanted = Math.max(500, Math.min(10_000, Math.round(intervalMs)));
    if (source && wanted !== activeIntervalMs) {
      source.stop();
      source = null;
    }
    activeIntervalMs = wanted;
  }

  if (!source) {
    source = factory();
    source.start(activeIntervalMs);
    startJanitor();
  }

  return {
    status: source.status(),
    frame: source.latest(),
    previous: source.previous(),
  };
}

/** Stop collecting and forget every setting — back to the boot state. */
export function disposeCensus(): void {
  source?.stop();
  source = null;
  if (janitor) clearInterval(janitor);
  janitor = null;
  lastAccessAt = 0;
  activeIntervalMs = DEFAULT_INTERVAL_MS;
}
