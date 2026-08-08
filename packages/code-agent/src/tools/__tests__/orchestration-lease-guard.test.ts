import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationLeaseGuard } from '../orchestration-lease-guard.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('orchestration lease guard', () => {
  it('loses ownership stickily, aborts the active executor, and clears its timer', async () => {
    vi.useFakeTimers();
    let renewals = 0;
    const lost = vi.fn();
    const guard = createOrchestrationLeaseGuard({
      label: 'workflow test',
      leaseMs: 60_000,
      renew: () => {
        renewals += 1;
        return renewals < 2;
      },
    });

    const stop = guard.start(lost);
    expect(guard.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(guard.isLost()).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(guard.isLost()).toBe(true);
    expect(guard.isRunning()).toBe(false);
    expect(lost).toHaveBeenCalledOnce();
    await expect(guard.assertOwned()).rejects.toThrow(/fenced|expired/);
    expect(renewals).toBe(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
