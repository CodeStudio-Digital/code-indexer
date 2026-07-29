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
  const runA = '00000000-0000-4000-8000-000000000001';
  const runB = '00000000-0000-4000-8000-000000000002';

  it('counts consecutive failures per run', () => {
    expect(trackSidecarFailure(runA)).toBe(1);
    expect(trackSidecarFailure(runA)).toBe(2);
    expect(trackSidecarFailure(runB)).toBe(1); // independent run
  });

  it('reset zeroes the streak but keeps counting after', () => {
    trackSidecarFailure(runA);
    resetSidecarTracker(runA);
    expect(trackSidecarFailure(runA)).toBe(1);
  });

  it('clear drops the run entirely', () => {
    trackSidecarFailure(runA);
    clearSidecarTracker(runA);
    expect(trackSidecarFailure(runA)).toBe(1);
  });

  it('threshold is 2 (route contract)', () => {
    expect(SIDECAR_DOWN_THRESHOLD).toBe(2);
  });
});
