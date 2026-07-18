import { describe, expect, it } from 'vitest';
import { hasStructuredToolTruncation, normalizeSourceTruncations } from '../tool-output-telemetry.js';

describe('hasStructuredToolTruncation', () => {
  it('bounds and validates untrusted source metadata', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      technique: `cap-${index}`,
      inputSize: 10,
      outputSize: 5,
      unit: 'chars',
      recoverable: true,
    }));
    const normalized = normalizeSourceTruncations([
      null,
      'bad',
      { technique: 'bad-unit', inputSize: 10, outputSize: 5, unit: 'widgets' },
      { technique: 'not-a-cut', inputSize: 5, outputSize: 10, unit: 'chars' },
      ...many,
    ]);
    expect(normalized).toHaveLength(12);
    expect(normalized[0]?.technique).toBe('cap-0');
    expect(normalized.at(-1)?.technique).toBe('cap-11');
  });

  it('ignores marker-like display content and spill-only bookkeeping', () => {
    expect(hasStructuredToolTruncation({})).toBe(false);
    expect(hasStructuredToolTruncation({
      reductionReport: { stages: [{ stage: 'spill' }] },
    })).toBe(false);
  });

  it('accepts only explicit block, producer or reduction evidence', () => {
    expect(hasStructuredToolTruncation({ truncated: true })).toBe(true);
    expect(hasStructuredToolTruncation({ sourceTruncations: [{}] })).toBe(true);
    for (const stage of ['source_cap', 'semantic', 'structured', 'recovery_marker', 'hard_cap']) {
      expect(hasStructuredToolTruncation({ reductionReport: { stages: [{ stage }] } }), stage)
        .toBe(true);
    }
  });
});
