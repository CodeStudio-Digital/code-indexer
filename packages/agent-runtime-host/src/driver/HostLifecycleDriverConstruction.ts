import {
  type AuthorityClock,
  createAuthorityClock,
} from '../ipc/AttemptClock.js';

const testingClocks = new WeakMap<object, AuthorityClock>();

export function bindLifecycleDriverClock(
  options: object,
  clock: AuthorityClock,
): void {
  testingClocks.set(options, clock);
}

export function takeLifecycleDriverClock(
  options: object,
): AuthorityClock {
  const clock = testingClocks.get(options);
  testingClocks.delete(options);
  return clock ?? createAuthorityClock();
}
