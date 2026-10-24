import { describe, expect, it } from 'vitest';
import {
  FOLLOW_RESUME_PX,
  isScrollbarPointer,
  shouldResumeFollow,
} from '../useFollowOutput.js';

describe('shouldResumeFollow', () => {
  it('resumes only at the real bottom, not merely near it', () => {
    expect(shouldResumeFollow(0)).toBe(true);
    expect(shouldResumeFollow(FOLLOW_RESUME_PX)).toBe(true);
    expect(shouldResumeFollow(FOLLOW_RESUME_PX + 1)).toBe(false);
    expect(shouldResumeFollow(400)).toBe(false);
    expect(shouldResumeFollow(-120)).toBe(true);
    expect(shouldResumeFollow(80)).toBe(false);
  });
});

describe('isScrollbarPointer', () => {
  it('separates a scrollbar grab from a click on content', () => {
    // Content box ends at 900; the gutter lives beyond it.
    expect(isScrollbarPointer(912, 900)).toBe(true);
    expect(isScrollbarPointer(900, 900)).toBe(false);
    expect(isScrollbarPointer(420, 900)).toBe(false);
  });
});
