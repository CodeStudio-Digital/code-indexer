import { afterEach, expect, it, vi } from 'vitest';
import { AttemptDeadlineGuard } from '../ipc/AttemptDeadlineGuard.js';

afterEach(() => vi.useRealTimers());

it.each([false, true])('bounds pending I/O separately from a capability operation: %s', async capability => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const expired = vi.fn();
  const guard = new AttemptDeadlineGuard({ now: () => BigInt(Date.now()) }, 61_000n, 30_000, expired);
  guard.start();
  guard.armPending(51_000n, capability);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(expired).toHaveBeenCalledTimes(capability ? 0 : 1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(expired).toHaveBeenCalledTimes(1);
  guard.close();
});

it('never extends capability confirmation past attempt authority', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const expired = vi.fn();
  const guard = new AttemptDeadlineGuard({ now: () => BigInt(Date.now()) }, 2000n, 100, expired);
  guard.start();
  guard.armPending(5000n, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(expired).toHaveBeenCalledTimes(1);
  guard.close();
});
