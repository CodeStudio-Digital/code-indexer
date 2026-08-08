/**
 * Tests for the proportional auto-compact buffer (window-aligned backstop).
 * A fixed 50K buffer used to go NEGATIVE on 32k windows (trigger=1 →
 * compaction attempted every turn until the no-op breaker silenced it);
 * the buffer is now (1 − triggerRatio) of the effective window, capped at
 * 50K for huge windows and floored at 1K.
 */
import { describe, it, expect } from 'vitest';
import { autocompactBufferTokens, deriveTokenLimits } from '../limits.js';

describe('autocompactBufferTokens', () => {
  it('is proportional on short windows (~10% of effective at default ratio 0.90)', () => {
    // Same float arithmetic as the implementation (1 − 0.9 = 0.0999…).
    expect(autocompactBufferTokens(23_808)).toBe(Math.floor(23_808 * (1 - 0.9)));
    expect(autocompactBufferTokens(60_000)).toBe(Math.floor(60_000 * (1 - 0.9)));
    // And the magnitude is right: within 1 token of a clean 10%.
    expect(Math.abs(autocompactBufferTokens(60_000) - 6_000)).toBeLessThanOrEqual(1);
  });

  it('caps at the 20K product ceiling on huge windows', () => {
    expect(autocompactBufferTokens(1_000_000)).toBe(20_000);
  });

  it('floors at 1K on tiny windows', () => {
    expect(autocompactBufferTokens(8_000)).toBe(1_000);
  });

  it('ignores retired process-env knobs', () => {
    process.env.CODER_COMPACT_TRIGGER_RATIO = '0.7';
    process.env.CODER_AUTOCOMPACT_BUFFER = '5000';
    expect(autocompactBufferTokens(100_000)).toBe(Math.floor(100_000 * (1 - 0.9)));
    delete process.env.CODER_COMPACT_TRIGGER_RATIO;
    delete process.env.CODER_AUTOCOMPACT_BUFFER;
  });
});

describe('deriveTokenLimits backstop', () => {
  it('keeps trigger above protect and never degenerate, known or unknown model', () => {
    for (const model of ['claude-haiku-4-5-20251001', 'totally-unknown-model-xyz']) {
      const l = deriveTokenLimits(model);
      expect(l.trigger).toBeGreaterThan(l.protect);
      // The 32k regression: trigger collapsed to 1 → compaction every turn.
      expect(l.trigger).toBeGreaterThan(1_000);
    }
  });
});
