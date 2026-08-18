import { describe, expect, it } from 'vitest';
import {
  computeFollowTransition,
  FOLLOW_RESUME_PX,
  FOLLOW_THRESHOLD_PX,
} from '../useFollowOutput.js';

describe('computeFollowTransition', () => {
  it('keeps following while the view stays within the end threshold', () => {
    expect(computeFollowTransition(0, true)).toBe(true);
    expect(computeFollowTransition(FOLLOW_THRESHOLD_PX, true)).toBe(true);
  });

  it('disengages once the user scrolls past the end threshold', () => {
    expect(computeFollowTransition(FOLLOW_THRESHOLD_PX + 1, true)).toBe(false);
    expect(computeFollowTransition(4000, true)).toBe(false);
  });

  it('treats elastic overscroll past the bottom as the end', () => {
    expect(computeFollowTransition(-120, true)).toBe(true);
    expect(computeFollowTransition(-120, false)).toBe(true);
  });

  it('re-engages only at the real bottom, not merely near it', () => {
    // Hysteresis: a small nudge upward must stay disengaged, otherwise the next
    // streamed frame yanks the view back down — the fight this hook removes.
    expect(computeFollowTransition(FOLLOW_RESUME_PX + 1, false)).toBe(false);
    expect(computeFollowTransition(FOLLOW_THRESHOLD_PX, false)).toBe(false);
    expect(computeFollowTransition(FOLLOW_RESUME_PX, false)).toBe(true);
    expect(computeFollowTransition(0, false)).toBe(true);
  });

  it('leaves a gap between disengage and resume thresholds', () => {
    expect(FOLLOW_RESUME_PX).toBeLessThan(FOLLOW_THRESHOLD_PX);
  });
});
