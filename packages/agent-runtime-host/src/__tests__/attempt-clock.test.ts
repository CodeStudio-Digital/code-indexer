import { describe, expect, it } from 'vitest';
import {
  createAnchoredClockForTesting,
} from '../ipc/AttemptClock.js';

describe('attempt authority clock', () => {
  it('anchors Unix time once and never regresses with monotonic jitter', () => {
    let wallCalls = 0;
    let monotonic = 1_000_000_000n;
    const clock = createAnchoredClockForTesting(
      () => {
        wallCalls += 1;
        return 1_000;
      },
      () => monotonic,
    );

    expect(clock.now()).toBe(1_000n);
    monotonic += 10_000_000n;
    expect(clock.now()).toBe(1_010n);
    monotonic -= 5_000_000n;
    expect(clock.now()).toBe(1_010n);
    expect(wallCalls).toBe(1);
  });

  it('rejects a monotonic source that moves behind its anchor', () => {
    let monotonic = 10n;
    const clock = createAnchoredClockForTesting(
      () => 1_000,
      () => monotonic,
    );
    monotonic = 9n;

    expect(() => clock.now()).toThrow(
      expect.objectContaining({ code: 'invalid_clock' }),
    );
  });
});
