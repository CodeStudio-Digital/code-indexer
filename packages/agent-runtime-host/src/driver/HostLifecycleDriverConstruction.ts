import {
  type AuthorityClock,
  createAuthorityClock,
} from '../ipc/AttemptClock.js';

const boundClocks = new WeakMap<object, AuthorityClock>();

export function bindLifecycleDriverClock(
  options: object,
  clock: AuthorityClock,
): void {
  boundClocks.set(options, clock);
}

export function takeLifecycleDriverClock(
  options: object,
): AuthorityClock {
  const clock = boundClocks.get(options);
  boundClocks.delete(options);
  return clock ?? createAuthorityClock();
}
