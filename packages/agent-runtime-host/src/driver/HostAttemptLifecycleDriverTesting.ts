import type { AuthorityClock } from '../ipc/AttemptClock.js';
import { HostAttemptLifecycleDriver } from './HostAttemptLifecycleDriver.js';
import {
  bindLifecycleDriverClock,
} from './HostLifecycleDriverConstruction.js';
import type {
  HostAttemptLifecycleDriverOptions,
} from './HostLifecycleTypes.js';

/** Internal test seam; unavailable through the package export map. */
export function createHostAttemptLifecycleDriverForTesting(
  options: HostAttemptLifecycleDriverOptions,
  clock: AuthorityClock,
): HostAttemptLifecycleDriver {
  bindLifecycleDriverClock(options, clock);
  return new HostAttemptLifecycleDriver(options);
}
