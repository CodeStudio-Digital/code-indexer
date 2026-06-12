/**
 * Unit tests for `shouldCompact90` / `computeProtectTokens`.
 *
 * Uses a real `deriveTokenLimits(model)` call so the tests double as
 * sanity checks that `claude-haiku-4-5-20251001` has a registered context
 * window (a regression in capabilities.ts would fail here).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  shouldCompact90,
  computeProtectTokens,
  resolveTriggerRatio,
  DEFAULT_TRIGGER_RATIO,
  DEFAULT_PROTECT_RATIO,
} from '../threshold.js';

const MODEL = 'claude-haiku-4-5-20251001';

afterEach(() => {
  delete process.env.CODER_COMPACT_TRIGGER_RATIO;
});

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

  it('default trigger ratio is 0.90 — window-relative, raised by operator decision', () => {
    expect(DEFAULT_TRIGGER_RATIO).toBe(0.9);
    // Window-relative, not a fixed cap: the trigger scales with the model.
    const big = shouldCompact90({ promptTokens: 1, model: MODEL });
    expect(Math.round(big.effective * DEFAULT_TRIGGER_RATIO)).toBeGreaterThan(0);
  });

  it('does NOT fire at 70% anymore (the old default)', () => {
    const base = shouldCompact90({ promptTokens: 1, model: MODEL });
    const at70 = Math.ceil(base.effective * 0.70);
    expect(shouldCompact90({ promptTokens: at70, model: MODEL }).shouldCompact).toBe(false);
  });

  it('reports promptTokens and effective in the decision payload', () => {
    const decision = shouldCompact90({ promptTokens: 12345, model: MODEL });
    expect(decision.promptTokens).toBe(12345);
    expect(decision.effective).toBeGreaterThan(0);
  });
});

describe('resolveTriggerRatio', () => {
  it('defaults to 0.90 without env', () => {
    expect(resolveTriggerRatio()).toBe(0.9);
  });

  it('honours CODER_COMPACT_TRIGGER_RATIO and drives shouldCompact90', () => {
    process.env.CODER_COMPACT_TRIGGER_RATIO = '0.7';
    expect(resolveTriggerRatio()).toBe(0.7);
    const base = shouldCompact90({ promptTokens: 1, model: MODEL });
    const at75 = Math.ceil(base.effective * 0.75);
    expect(shouldCompact90({ promptTokens: at75, model: MODEL }).shouldCompact).toBe(true);
  });

  it('clamps typos into [0.5, 0.95] and ignores garbage', () => {
    process.env.CODER_COMPACT_TRIGGER_RATIO = '0.1';
    expect(resolveTriggerRatio()).toBe(0.5);
    process.env.CODER_COMPACT_TRIGGER_RATIO = '5';
    expect(resolveTriggerRatio()).toBe(0.95);
    process.env.CODER_COMPACT_TRIGGER_RATIO = 'banana';
    expect(resolveTriggerRatio()).toBe(0.9);
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
