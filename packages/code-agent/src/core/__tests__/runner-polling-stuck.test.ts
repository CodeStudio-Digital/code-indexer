import { describe, expect, it } from 'vitest';
import { buildPollingStuckRefusal } from '../runner.js';

describe('buildPollingStuckRefusal', () => {
  it('explains that identical poll results require a strategy change', () => {
    const out = buildPollingStuckRefusal({
      toolName: 'wait_for_build',
      count: 10,
      firstTurn: 3,
    });

    expect(out).toContain('wait_for_build');
    expect(out).toContain('IDENTICAL result 10 consecutive times');
    expect(out).toContain('first seen turn 3');
    expect(out).toContain('Change strategy');
  });

  it('is deterministic', () => {
    const args = { toolName: 'poll_status', count: 12, firstTurn: 4 };
    expect(buildPollingStuckRefusal(args)).toBe(buildPollingStuckRefusal(args));
  });
});
