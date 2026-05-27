/**
 * Unit tests for the max-turns guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkMaxTurns, maxAutoContinues } from '../max-turns.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('checkMaxTurns', () => {
  it('returns continue below the cap', () => {
    const verdict = checkMaxTurns({ turn: 10, autoContinues: 0, maxTurns: 50 });
    expect(verdict.kind).toBe('continue');
  });

  it('returns auto-continue at the cap with continues left', () => {
    const verdict = checkMaxTurns({ turn: 50, autoContinues: 0, maxTurns: 50 });
    expect(verdict.kind).toBe('auto-continue');
    if (verdict.kind === 'auto-continue') {
      expect(verdict.nextCount).toBe(1);
    }
  });

  it('stops when auto-continues are exhausted', () => {
    const verdict = checkMaxTurns({ turn: 50, autoContinues: 3, maxTurns: 50 });
    expect(verdict.kind).toBe('stop');
  });

  it('honours CODER_MAX_AUTO_CONTINUES override', () => {
    vi.stubEnv('CODER_MAX_AUTO_CONTINUES', '1');
    expect(maxAutoContinues()).toBe(1);
    expect(checkMaxTurns({ turn: 50, autoContinues: 1, maxTurns: 50 }).kind).toBe('stop');
  });

  it('treats turn beyond maxTurns identically to == maxTurns', () => {
    const verdict = checkMaxTurns({ turn: 51, autoContinues: 0, maxTurns: 50 });
    expect(verdict.kind).toBe('auto-continue');
  });
});
