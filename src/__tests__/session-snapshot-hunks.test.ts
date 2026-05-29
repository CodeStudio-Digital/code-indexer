import { describe, expect, it } from 'vitest';
import { applyHunkRevert, computeHunks } from '@mcp/services/services/snapshot-hunks.js';

describe('snapshot-hunks — computeHunks', () => {
  it('returns no hunks when before == after', () => {
    expect(computeHunks('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
  });

  it('represents a pure addition (null baseline → file created)', () => {
    const hunks = computeHunks(null, 'a\nb\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].addedCount).toBe(2);
    expect(hunks[0].removedCount).toBe(0);
  });

  it('represents a pure deletion (after = empty → file deleted)', () => {
    const hunks = computeHunks('a\nb\nc\n', '');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].removedCount).toBe(3);
    expect(hunks[0].addedCount).toBe(0);
  });

  it('groups a single modification into one hunk with surrounding context', () => {
    const before = 'a\nb\nc\nd\ne\nf\n';
    const after = 'a\nb\nC\nd\ne\nf\n';
    const hunks = computeHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].addedCount).toBe(1);
    expect(hunks[0].removedCount).toBe(1);
    expect(hunks[0].lines.some((l) => l.type === 'add' && l.content === 'C')).toBe(true);
    expect(hunks[0].lines.some((l) => l.type === 'remove' && l.content === 'c')).toBe(true);
  });

  it('produces stable fingerprints for the same diff', () => {
    const a = computeHunks('a\nb\nc\n', 'a\nB\nc\n');
    const b = computeHunks('a\nb\nc\n', 'a\nB\nc\n');
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
  });

  it('invalidates the fingerprint when the same region is re-edited', () => {
    const v1 = computeHunks('a\nb\nc\n', 'a\nB\nc\n')[0].fingerprint;
    const v2 = computeHunks('a\nb\nc\n', 'a\nB2\nc\n')[0].fingerprint;
    expect(v1).not.toBe(v2);
  });

  it('normalizes CRLF → LF so mixed line endings do not produce phantom hunks', () => {
    const lf = 'a\nb\nc\n';
    const crlf = 'a\r\nb\r\nc\r\n';
    expect(computeHunks(lf, crlf)).toEqual([]);
    expect(computeHunks(crlf, lf)).toEqual([]);
  });

  it('separates two distant changes into independent hunks', () => {
    const before = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'l11'].join('\n');
    const after = ['L1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'L11'].join('\n');
    const hunks = computeHunks(before, after);
    expect(hunks.length).toBe(2);
    expect(hunks[0].fingerprint).not.toBe(hunks[1].fingerprint);
  });

  it('keeps a top-of-file edit compact instead of absorbing the unchanged tail', () => {
    const beforeLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const afterLines = [...beforeLines];
    afterLines[0] = 'changed line 1';
    const hunks = computeHunks(`${beforeLines.join('\n')}\n`, `${afterLines.join('\n')}\n`);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toHaveLength(5);
    expect(hunks[0].hiddenBefore).toBe(0);
    expect(hunks[0].hiddenAfter).toBe(96);
    expect(hunks[0].canExpandAfter).toBe(true);
  });

  it('keeps an end-of-file edit compact with only leading context', () => {
    const beforeLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const afterLines = [...beforeLines];
    afterLines[99] = 'changed line 100';
    const hunks = computeHunks(`${beforeLines.join('\n')}\n`, `${afterLines.join('\n')}\n`);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toHaveLength(5);
    expect(hunks[0].hiddenBefore).toBe(96);
    expect(hunks[0].hiddenAfter).toBe(0);
    expect(hunks[0].canExpandBefore).toBe(true);
  });

  it('supports incremental context expansion without changing hunk identity', () => {
    const beforeLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const afterLines = [...beforeLines];
    afterLines[29] = 'changed line 30';
    const compact = computeHunks(`${beforeLines.join('\n')}\n`, `${afterLines.join('\n')}\n`)[0];
    const expanded = computeHunks(`${beforeLines.join('\n')}\n`, `${afterLines.join('\n')}\n`, {
      context: 3,
      contextBefore: 13,
      contextAfter: 3,
    })[0];
    expect(expanded.lines.length).toBe(compact.lines.length + 10);
    expect(expanded.hiddenBefore).toBe(compact.hiddenBefore - 10);
    expect(expanded.fingerprint).toBe(compact.fingerprint);
  });
});

describe('snapshot-hunks — applyHunkRevert', () => {
  it('reverts a single hunk back to the baseline lines (changes far apart → two hunks)', () => {
    const baseline = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'].join('\n') + '\n';
    const current = ['a1', 'X2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'X10'].join('\n') + '\n';
    const hunks = computeHunks(baseline, current);
    expect(hunks).toHaveLength(2);
    const firstReverted = applyHunkRevert(baseline, current, hunks[0]);
    expect(firstReverted).not.toBeNull();
    // First hunk targets line 2 (X2 → a2); line 10 still says X10.
    expect(firstReverted).toBe(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'X10'].join('\n') + '\n');
  });

  it('returns null when the hunk no longer applies (file moved on)', () => {
    const baseline = 'a\nb\nc\n';
    const current = 'a\nB\nc\n';
    const hunks = computeHunks(baseline, current);
    // Simulate a further mutation that destroys the after-image of the hunk.
    const moved = 'a\nZ\nc\n';
    expect(applyHunkRevert(baseline, moved, hunks[0])).toBeNull();
  });
});
