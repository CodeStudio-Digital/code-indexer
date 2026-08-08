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
  contextSpillCeilingChars,
  resolveFinalizeCap,
  DEFAULT_TRIGGER_RATIO,
  DEFAULT_PROTECT_RATIO,
} from '../threshold.js';
import { estimateBlockTokens } from '@mcp/code-agent/core/token-accounting.js';
import { capToolContent } from '../../pure-helpers.js';

const MODEL = 'claude-haiku-4-5-20251001';

afterEach(() => {
  delete process.env.CODER_COMPACT_TRIGGER_RATIO;
  delete process.env.CODER_CONTEXT_SPILL_RATIO;
});

describe('contextSpillCeilingChars (P3)', () => {
  it('keeps a ceiling-sized dense tool_result AT or under the protect budget (the real invariant)', () => {
    // This is the property the spill exists to guarantee: a tool_result clamped
    // at the ceiling — head + the marker capToolContent appends — must estimate
    // ≤ protectTokens, INCLUDING the per-block overhead estimateBlockTokens adds.
    const protectTokens = computeProtectTokens({ model: MODEL });
    const ceiling = contextSpillCeilingChars(MODEL);
    expect(ceiling).toBeLessThan(protectTokens * 2); // margin reserved, not a bare 2×
    // Densest possible content, longer than the ceiling so capToolContent caps it.
    const dense = '{"k":'.repeat(ceiling); // JSON-punctuation-heavy → /2 estimate
    const capped = capToolContent(dense, ceiling, 'oid-test');
    expect(capped.truncated).toBe(true);
    const block = { type: 'tool_result' as const, tool_use_id: 't', content: capped.content };
    expect(estimateBlockTokens(block)).toBeLessThanOrEqual(protectTokens);
  });

  it('cannot be disabled through process env', () => {
    const expected = contextSpillCeilingChars(MODEL);
    process.env.CODER_CONTEXT_SPILL_RATIO = '0';
    expect(contextSpillCeilingChars(MODEL)).toBe(expected);
  });
});

describe('resolveFinalizeCap (P3 clamp wiring)', () => {
  it('clamps a large user cap down to the context ceiling', () => {
    const ceiling = contextSpillCeilingChars(MODEL);
    // A user on max/ultra has an effective cap far above the ceiling.
    expect(resolveFinalizeCap(10_000_000, MODEL)).toBe(ceiling);
  });

  it('leaves a user cap below the ceiling untouched', () => {
    expect(resolveFinalizeCap(1000, MODEL)).toBe(1000);
  });

  it('keeps the safety ceiling when a retired env knob is set', () => {
    const ceiling = contextSpillCeilingChars(MODEL);
    process.env.CODER_CONTEXT_SPILL_RATIO = '0';
    expect(resolveFinalizeCap(10_000_000, MODEL)).toBe(ceiling);
  });
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

  it('ignores the retired process-env trigger knob', () => {
    process.env.CODER_COMPACT_TRIGGER_RATIO = '0.7';
    expect(resolveTriggerRatio()).toBe(0.9);
    const base = shouldCompact90({ promptTokens: 1, model: MODEL });
    const at75 = Math.ceil(base.effective * 0.75);
    expect(shouldCompact90({ promptTokens: at75, model: MODEL }).shouldCompact).toBe(false);
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
