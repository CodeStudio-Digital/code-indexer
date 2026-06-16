/**
 * Tool-output cap LEVEL resolver (`output-caps.ts`).
 *
 * Pure-function coverage: the 6-level scale across every (base, ceiling) pair
 * the runtime uses, the monotonic clamp, the bounded `ultra` ceiling, plus the
 * DB/HTTP parser and the legacy-boolean bridge.
 */
import { describe, it, expect } from 'vitest';
import {
  capFor,
  parseToolOutputCapLevel,
  levelFromLegacyBoolean,
  TOOL_OUTPUT_CAP_LEVELS,
} from '../output-caps.js';

// The five (base, ceiling) pairs the cap sites pass at runtime.
const PAIRS: Record<string, [number, number]> = {
  main: [24_000, 1_000_000],
  subagent: [12_000, 500_000],
  mcp: [200_000, 1_000_000],
  codeExec: [50_000, 1_000_000],
  readFileLines: [800, 5_000],
};

describe('capFor — headline main-runner scale (24k base, 1M ceiling)', () => {
  const [base, ceil] = PAIRS.main;
  it('economic = 1× base', () => expect(capFor('economic', base, ceil)).toBe(24_000));
  it('medium = 2× base', () => expect(capFor('medium', base, ceil)).toBe(48_000));
  it('high = 4× base', () => expect(capFor('high', base, ceil)).toBe(96_000));
  it('extra = 6× base', () => expect(capFor('extra', base, ceil)).toBe(144_000));
  it('max = ceiling', () => expect(capFor('max', base, ceil)).toBe(1_000_000));
  it('ultra = 4× ceiling (≈4 MB, bounded)', () => expect(capFor('ultra', base, ceil)).toBe(4_000_000));
});

describe('capFor — monotonic clamp', () => {
  it('clamps finite sub-max levels to the ceiling (MCP 200k base: 6×=1.2M → 1M)', () => {
    expect(capFor('high', 200_000, 1_000_000)).toBe(800_000);
    expect(capFor('extra', 200_000, 1_000_000)).toBe(1_000_000);
    expect(capFor('max', 200_000, 1_000_000)).toBe(1_000_000);
  });

  it('is non-decreasing across the level order for every (base, ceiling) pair', () => {
    for (const [base, ceil] of Object.values(PAIRS)) {
      const caps = TOOL_OUTPUT_CAP_LEVELS.map((lv) => capFor(lv, base, ceil));
      for (let i = 1; i < caps.length; i++) {
        expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
      }
      // ultra is always the largest, strictly above max, and finite (no NO_CAP).
      const ultra = caps[caps.length - 1];
      expect(ultra).toBe(ceil * 4);
      expect(ultra).toBeGreaterThan(capFor('max', base, ceil));
      expect(Number.isFinite(ultra)).toBe(true);
    }
  });
});

describe('capFor — secondary pairs', () => {
  it('subagent (12k/500k): max=500k, ultra=2M', () => {
    expect(capFor('max', 12_000, 500_000)).toBe(500_000);
    expect(capFor('ultra', 12_000, 500_000)).toBe(2_000_000);
  });

  it('read_file line units (800/5000): scales + clamps in lines', () => {
    expect(capFor('economic', 800, 5_000)).toBe(800);
    expect(capFor('high', 800, 5_000)).toBe(3_200);
    expect(capFor('extra', 800, 5_000)).toBe(4_800);
    expect(capFor('max', 800, 5_000)).toBe(5_000);
    expect(capFor('ultra', 800, 5_000)).toBe(20_000);
  });
});

describe('parseToolOutputCapLevel', () => {
  it('accepts the 6 valid levels', () => {
    for (const lv of TOOL_OUTPUT_CAP_LEVELS) expect(parseToolOutputCapLevel(lv)).toBe(lv);
  });
  it('rejects unknown / empty / non-string → null', () => {
    expect(parseToolOutputCapLevel('huge')).toBeNull();
    expect(parseToolOutputCapLevel('')).toBeNull();
    expect(parseToolOutputCapLevel(null)).toBeNull();
    expect(parseToolOutputCapLevel(undefined)).toBeNull();
    expect(parseToolOutputCapLevel(1)).toBeNull();
  });
});

describe('levelFromLegacyBoolean', () => {
  it('true → max; false/null/undefined → economic', () => {
    expect(levelFromLegacyBoolean(true)).toBe('max');
    expect(levelFromLegacyBoolean(false)).toBe('economic');
    expect(levelFromLegacyBoolean(null)).toBe('economic');
    expect(levelFromLegacyBoolean(undefined)).toBe('economic');
  });
});
