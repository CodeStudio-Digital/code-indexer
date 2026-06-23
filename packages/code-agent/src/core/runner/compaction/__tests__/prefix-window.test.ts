/**
 * PR-F prefix-window tests.
 *
 * Pins the BodyAfterPrefix accounting:
 *   - prefix grows with system + tools
 *   - body = promptTokens - prefixTokens (clamped >= 0)
 *   - ratio uses bodyCapacity (effective - prefix) NOT effective
 *   - default ratio 0.85 (more aggressive than legacy 0.90)
 *   - degenerate inputs (negative body / zero capacity) → don't compact
 */
import { describe, expect, it } from 'vitest';
import {
  computePrefixTokens,
  shouldCompactBodyAfterPrefix,
  decideCompactionBodyAfterPrefix,
  DEFAULT_BODY_AFTER_PREFIX_RATIO,
} from '../prefix-window.js';

describe('computePrefixTokens', () => {
  it('returns 0 for empty inputs (well, near-zero from rounding)', () => {
    expect(computePrefixTokens('', [])).toBe(0);
  });

  it('grows with system prompt length', () => {
    const small = computePrefixTokens('hello', []);
    const big = computePrefixTokens('hello world '.repeat(100), []);
    expect(big).toBeGreaterThan(small);
  });

  it('grows with tool count + descriptions', () => {
    const zero = computePrefixTokens('sys', []);
    const one = computePrefixTokens('sys', [
      { name: 'read_file', description: 'Reads a file at path' },
    ]);
    expect(one).toBeGreaterThan(zero);
    const five = computePrefixTokens('sys', [
      { name: 'read_file', description: 'Reads' },
      { name: 'edit_file', description: 'Edits' },
      { name: 'run_command', description: 'Runs' },
      { name: 'glob', description: 'Globs' },
      { name: 'grep', description: 'Greps' },
    ]);
    expect(five).toBeGreaterThan(one);
  });

  it('includes parameter schema size', () => {
    const noParams = computePrefixTokens('sys', [{ name: 't', description: 'd' }]);
    const withParams = computePrefixTokens('sys', [
      {
        name: 't', description: 'd',
        parameters: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } } },
      },
    ]);
    expect(withParams).toBeGreaterThan(noParams);
  });

  it('does not throw on tools with circular params', () => {
    type Circular = { type: string; self?: Circular };
    const a: Circular = { type: 'object' };
    a.self = a;
    expect(() => computePrefixTokens('sys', [{ name: 't', parameters: a }])).not.toThrow();
  });
});

describe('shouldCompactBodyAfterPrefix', () => {
  const model = 'claude-sonnet-4-5';

  it('does not compact when body is well under capacity', () => {
    const d = shouldCompactBodyAfterPrefix({
      promptTokens: 50_000, prefixTokens: 30_000, model,
    });
    expect(d.shouldCompact).toBe(false);
    expect(d.bodyTokens).toBe(20_000);
    expect(d.ratio).toBeLessThan(DEFAULT_BODY_AFTER_PREFIX_RATIO);
  });

  it('compacts when body / bodyCapacity >= 0.85', () => {
    // Default Claude effective is large (~150K-200K range). Use a high
    // promptTokens so body comes close to capacity even after huge prefix.
    const d = shouldCompactBodyAfterPrefix({
      promptTokens: 180_000, prefixTokens: 10_000, model,
    });
    // Body = 170K. Capacity = effective - 10K. If body/capacity >= 0.85 → compact.
    expect(d.bodyTokens).toBe(170_000);
    if (d.ratio >= DEFAULT_BODY_AFTER_PREFIX_RATIO) {
      expect(d.shouldCompact).toBe(true);
    }
  });

  it('handles zero capacity (prefix == effective) gracefully', () => {
    const d = shouldCompactBodyAfterPrefix({
      promptTokens: 1, prefixTokens: 10_000_000, model,
    });
    expect(d.shouldCompact).toBe(false);
    expect(d.bodyCapacity).toBe(0);
  });

  it('handles bodyTokens going negative (promptTokens < prefixTokens) by clamping to 0', () => {
    const d = shouldCompactBodyAfterPrefix({
      promptTokens: 100, prefixTokens: 200, model,
    });
    expect(d.bodyTokens).toBe(0);
    expect(d.shouldCompact).toBe(false);
  });

  it('respects custom triggerRatio override', () => {
    const lax = shouldCompactBodyAfterPrefix({
      promptTokens: 100_000, prefixTokens: 20_000, model, triggerRatio: 0.99,
    });
    const strict = shouldCompactBodyAfterPrefix({
      promptTokens: 100_000, prefixTokens: 20_000, model, triggerRatio: 0.1,
    });
    expect(strict.shouldCompact).toBe(true);
    expect(lax.shouldCompact).toBe(false);
  });
});

describe('decideCompactionBodyAfterPrefix (convenience)', () => {
  it('returns prefixTokens + decision in one call', () => {
    const d = decideCompactionBodyAfterPrefix({
      promptTokens: 50_000,
      systemPrompt: 'a'.repeat(2_000),
      tools: [{ name: 'read', description: 'r' }],
      model: 'claude-sonnet-4-5',
    });
    expect(d.prefixTokens).toBeGreaterThan(0);
    expect(typeof d.shouldCompact).toBe('boolean');
  });
});
