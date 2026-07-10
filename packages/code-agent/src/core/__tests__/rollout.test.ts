import { afterEach, describe, expect, it } from 'vitest';
import { rolloutEnabled } from '../rollout.js';

afterEach(() => { delete process.env.TEST_ROLLOUT_PERCENT; });

describe('rolloutEnabled', () => {
  it('supports independent 0 and 100 percent rollback flags', () => {
    process.env.TEST_ROLLOUT_PERCENT = '0';
    expect(rolloutEnabled('TEST_ROLLOUT_PERCENT', 'run-a')).toBe(false);
    process.env.TEST_ROLLOUT_PERCENT = '100';
    expect(rolloutEnabled('TEST_ROLLOUT_PERCENT', 'run-a')).toBe(true);
  });

  it('is deterministic for partial rollouts', () => {
    process.env.TEST_ROLLOUT_PERCENT = '10';
    expect(rolloutEnabled('TEST_ROLLOUT_PERCENT', 'same-run'))
      .toBe(rolloutEnabled('TEST_ROLLOUT_PERCENT', 'same-run'));
  });

  it('falls back safely for invalid values', () => {
    process.env.TEST_ROLLOUT_PERCENT = 'NaN';
    expect(rolloutEnabled('TEST_ROLLOUT_PERCENT', 'run-a', 100)).toBe(true);
  });
});
