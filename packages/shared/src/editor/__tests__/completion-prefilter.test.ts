import { describe, it, expect, afterEach } from 'vitest';
import {
  shouldSkipCompletion,
  extractGateFeatures,
  scoreAcceptLikelihood,
  __setGateWeightsForTests,
  type PrefilterCtx,
} from '../completion-prefilter.js';
import { COMPLETION_GATE_WEIGHTS } from '../completion-gate-weights.js';

function ctx(over: Partial<PrefilterCtx>): PrefilterCtx {
  return {
    lineBefore: '  $x = ',
    lineAfter: '',
    languageId: 'php',
    prefixTotalTrimmedLen: 500,
    suppression: 'standard',
    ...over,
  };
}

describe('R1 — statement enders at EOL', () => {
  it('skips after ; } ) ] at end of line', () => {
    for (const ch of [';', '}', ')', ']']) {
      expect(shouldSkipCompletion(ctx({ lineBefore: `  doThing()${ch}` }))).toMatchObject({ skip: true, rule: 'r1' });
    }
  });
  it('does NOT skip after { at standard (fresh-block = best multiline spot); strict does', () => {
    expect(shouldSkipCompletion(ctx({ lineBefore: 'function f() {' })).skip).toBe(false);
    expect(shouldSkipCompletion(ctx({ lineBefore: 'function f() {', suppression: 'strict' })))
      .toMatchObject({ skip: true, rule: 'r1' });
  });
  it('does not fire mid-line (text after the cursor)', () => {
    expect(shouldSkipCompletion(ctx({ lineBefore: '  x();', lineAfter: ' // trailing' })).skip).toBe(false);
  });
});

describe('R2 — comments', () => {
  it('skips an empty or sentence-terminated comment', () => {
    expect(shouldSkipCompletion(ctx({ lineBefore: '  // ' }))).toMatchObject({ skip: true, rule: 'r2' });
    expect(shouldSkipCompletion(ctx({ lineBefore: '// setup complete.' }))).toMatchObject({ skip: true, rule: 'r2' });
  });
  it('keeps a mid-sentence comment (continuation is a real use-case)', () => {
    expect(shouldSkipCompletion(ctx({ lineBefore: '// this function handles' })).skip).toBe(false);
  });
});

describe('R3 — mid-identifier', () => {
  it('skips when the cursor splits an identifier without a member trigger', () => {
    expect(shouldSkipCompletion(ctx({ lineBefore: '  $totalSer', lineAfter: 'vices = 1;' })))
      .toMatchObject({ skip: true, rule: 'r3' });
  });
  it('allows it right after a member trigger', () => {
    expect(shouldSkipCompletion(ctx({ lineBefore: '  $this->to', lineAfter: 'tal' })).skip).toBe(false);
  });
  it('applies even in lenient mode', () => {
    expect(shouldSkipCompletion(ctx({ lineBefore: 'foo', lineAfter: 'bar', suppression: 'lenient' })))
      .toMatchObject({ skip: true, rule: 'r3' });
  });
});

describe('R4 — import lines', () => {
  it('skips while typing an import/use statement (standard+strict only)', () => {
    expect(shouldSkipCompletion(ctx({ lineBefore: 'use App\\Models\\' }))).toMatchObject({ skip: true, rule: 'r4' });
    expect(shouldSkipCompletion(ctx({ lineBefore: "import { x } from '", suppression: 'lenient' })).skip).toBe(false);
  });
});

describe('R5/R6 — degenerate buffers', () => {
  it('skips a near-empty buffer (telemetry: rawChars≈0 → 100% empty)', () => {
    expect(shouldSkipCompletion(ctx({ prefixTotalTrimmedLen: 3 }))).toMatchObject({ skip: true, rule: 'r5' });
  });
  it('skips pathological lines >500 chars', () => {
    expect(shouldSkipCompletion(ctx({ lineBefore: 'x'.repeat(501) + ' ' }))).toMatchObject({ skip: true, rule: 'r6' });
  });
});

describe('normal completion positions pass', () => {
  it.each([
    ['fresh line', '    ', ''],
    ['after assignment', '  $result = ', ''],
    ['member access', '  $this->', ''],
    ['call open paren', '  $svc->handle(', ''],
  ])('%s', (_name, lineBefore, lineAfter) => {
    expect(shouldSkipCompletion(ctx({ lineBefore, lineAfter })).skip).toBe(false);
  });
});

describe('R7 — learned gate (trigger model)', () => {
  afterEach(() => __setGateWeightsForTests(null));

  it('shipping weights are the neutral bootstrap: gate inert, score 0.5', () => {
    expect(COMPLETION_GATE_WEIGHTS.trainedAt).toBeNull();
    expect(scoreAcceptLikelihood(extractGateFeatures(ctx({})))).toBe(0.5);
    expect(shouldSkipCompletion(ctx({ lineBefore: '  $result = ' })).skip).toBe(false);
  });

  it('trained weights below the threshold skip with rule r7; lenient stays exempt', () => {
    __setGateWeightsForTests({
      version: 1, trainedAt: '2026-07-20T00:00:00Z', samples: 1000,
      bias: -3, weights: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // sigmoid(-3) ≈ 0.047
      thresholds: { strict: 0.35, standard: 0.25, lenient: 0.12 },
    });
    expect(shouldSkipCompletion(ctx({ lineBefore: '  $result = ' })))
      .toMatchObject({ skip: true, rule: 'r7' });
    // Lenient short-circuits before R7 — the deterministic escape hatch.
    expect(shouldSkipCompletion(ctx({ lineBefore: '  $result = ', suppression: 'lenient' })).skip)
      .toBe(false);
  });

  it('trained weights above the threshold let the request through', () => {
    __setGateWeightsForTests({
      version: 1, trainedAt: '2026-07-20T00:00:00Z', samples: 1000,
      bias: 2, weights: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // sigmoid(2) ≈ 0.88
      thresholds: { strict: 0.35, standard: 0.25, lenient: 0.12 },
    });
    expect(shouldSkipCompletion(ctx({ lineBefore: '  $result = ' })).skip).toBe(false);
  });

  it('extractGateFeatures produces the versioned 13-slot layout', () => {
    const f = extractGateFeatures({
      lineBefore: '  $this->', lineAfter: '', languageId: 'php', prefixTotalTrimmedLen: 2000,
    });
    expect(f).toHaveLength(COMPLETION_GATE_WEIGHTS.weights.length);
    expect(f[2]).toBe(1);   // member trigger
    expect(f[4]).toBe(1);   // line-after blank
    expect(f[8]).toBe(0.5); // 2000/4000 prefix size
    expect(f[11]).toBe(1);  // php = curly-brace language
    for (const v of f) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of f) expect(v).toBeLessThanOrEqual(1);
  });
});
