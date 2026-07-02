import { describe, it, expect, beforeEach } from 'vitest';
import {
  SIDECAR_DOWN_THRESHOLD,
  clearAllSidecarTrackers,
  clearSidecarTracker,
  resetSidecarTracker,
  trackSidecarFailure,
} from '../sidecar-down-tracker.js';

beforeEach(() => clearAllSidecarTrackers());

describe('sidecar-down tracker', () => {
  it('counts consecutive failures per run', () => {
    expect(trackSidecarFailure(1)).toBe(1);
    expect(trackSidecarFailure(1)).toBe(2);
    expect(trackSidecarFailure(2)).toBe(1); // independent run
  });

  it('reset zeroes the streak but keeps counting after', () => {
    trackSidecarFailure(1);
    resetSidecarTracker(1);
    expect(trackSidecarFailure(1)).toBe(1);
  });

  it('clear drops the run entirely', () => {
    trackSidecarFailure(1);
    clearSidecarTracker(1);
    expect(trackSidecarFailure(1)).toBe(1);
  });

  it('threshold is 2 (route contract)', () => {
    expect(SIDECAR_DOWN_THRESHOLD).toBe(2);
  });
});
