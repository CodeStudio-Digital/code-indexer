import { describe, it, expect } from 'vitest';
import { shouldSkipCompletion, type PrefilterCtx } from '../completion-prefilter.js';

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
