import { describe, expect, it, vi } from 'vitest';
import { consumeAutoContinueSignals } from '../auto-continue-signals.js';

describe('consumeAutoContinueSignals', () => {
  it('drains both mirrored flags so one answer causes only one continuation', () => {
    const humanInLoop = {
      consume: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValue(false),
    };
    const master = {
      consume: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValue(false),
    };

    expect(consumeAutoContinueSignals(humanInLoop, master)).toBe(true);
    expect(consumeAutoContinueSignals(humanInLoop, master)).toBe(false);
    expect(humanInLoop.consume).toHaveBeenCalledTimes(2);
    expect(master.consume).toHaveBeenCalledTimes(2);
  });
});
