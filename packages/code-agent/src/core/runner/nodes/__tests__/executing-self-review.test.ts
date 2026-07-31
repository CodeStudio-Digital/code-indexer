import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../../machine/types.js';
import { computeSelfReviewNudge } from '../executing-self-review.js';

function context(): RunContext {
  return {
    injectionState: {
      selfReview: { suppressed: false },
    },
    opts: {
      hasReviewableChanges: async () => true,
    },
  } as unknown as RunContext;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('computeSelfReviewNudge', () => {
  it('does not push a review ceremony by default', async () => {
    vi.stubEnv('CODER_SELF_REVIEW', '');
    await expect(computeSelfReviewNudge(context())).resolves.toBe(false);
  });

  it('still supports an explicit opt-in', async () => {
    vi.stubEnv('CODER_SELF_REVIEW', '1');
    await expect(computeSelfReviewNudge(context())).resolves.toBe(true);
  });
});
