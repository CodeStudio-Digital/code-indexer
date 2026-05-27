/**
 * Unit tests for `shouldCompact90` / `computeProtectTokens`.
 *
 * Uses a real `deriveTokenLimits(model)` call so the tests double as
 * sanity checks that `claude-haiku-4-5-20251001` has a registered context
 * window (a regression in capabilities.ts would fail here).
 */
import { describe, it, expect } from 'vitest';
import {
  shouldCompact90,
  computeProtectTokens,
  DEFAULT_TRIGGER_RATIO,
  DEFAULT_PROTECT_RATIO,
} from '../threshold.js';

const MODEL = 'claude-haiku-4-5-20251001';

describe('shouldCompact90', () => {
  it('does not fire at low usage', () => {
    const decision = shouldCompact90({ promptTokens: 1000, model: MODEL });
    expect(decision.shouldCompact).toBe(false);
    expect(decision.ratio).toBeLessThan(DEFAULT_TRIGGER_RATIO);
  });

  it('fires at >= 90% usage by default', () => {
    const small = shouldCompact90({ promptTokens: 1000, model: MODEL });
    // Compute the trigger point from the same effective window the function uses.
    const triggerTokens = Math.ceil(small.effective * DEFAULT_TRIGGER_RATIO);
    const decision = shouldCompact90({ promptTokens: triggerTokens, model: MODEL });
    expect(decision.shouldCompact).toBe(true);
  });

  it('honours a custom triggerRatio', () => {
    const decision = shouldCompact90({
      promptTokens: 100,
      model: MODEL,
      triggerRatio: 0.0001,
    });
    expect(decision.shouldCompact).toBe(true);
  });

  it('returns shouldCompact=false for zero promptTokens', () => {
    const decision = shouldCompact90({ promptTokens: 0, model: MODEL });
    expect(decision.shouldCompact).toBe(false);
    expect(decision.ratio).toBe(0);
  });

  it('reports promptTokens and effective in the decision payload', () => {
    const decision = shouldCompact90({ promptTokens: 12345, model: MODEL });
    expect(decision.promptTokens).toBe(12345);
    expect(decision.effective).toBeGreaterThan(0);
  });
});

describe('computeProtectTokens', () => {
  it('returns 40% of effective window by default', () => {
    const tokens = computeProtectTokens({ model: MODEL });
    const baseline = shouldCompact90({ promptTokens: 1, model: MODEL });
    expect(tokens).toBe(Math.floor(baseline.effective * DEFAULT_PROTECT_RATIO));
  });

  it('honours a custom protectRatio', () => {
    const tokens = computeProtectTokens({ model: MODEL, protectRatio: 0.2 });
    const baseline = shouldCompact90({ promptTokens: 1, model: MODEL });
    expect(tokens).toBe(Math.floor(baseline.effective * 0.2));
  });

  it('floors at 1 token (never zero)', () => {
    const tokens = computeProtectTokens({ model: MODEL, protectRatio: 0 });
    expect(tokens).toBeGreaterThanOrEqual(1);
  });
});
