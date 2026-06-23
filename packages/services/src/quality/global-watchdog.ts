/**
 * Process-wide singleton for {@link QualityWatchdog}.
 *
 * Mirrors the `setGlobalQualityClassifierPipeline` / `setGlobalPolicyEnforcer`
 * pattern — the coder runner consults the global at construction time so
 * watchdog wiring stays optional (tests / headless runs / disabled-by-env
 * setups all degrade to "no watchdog" with zero overhead).
 *
 * Boot-side wiring lives in `apps/http-api/server.ts`. The runner imports
 * `getGlobalQualityWatchdog` lazily inside its constructor.
 */
import type { QualityWatchdog } from './QualityWatchdog.js';

let watchdog: QualityWatchdog | null = null;

export function setGlobalQualityWatchdog(instance: QualityWatchdog | null): void {
  watchdog = instance;
}

export function getGlobalQualityWatchdog(): QualityWatchdog | null {
  return watchdog;
}
