/**
 * Pure tests for the change-marker model (no Monaco). Verifies added /
 * modified / deleted classification, the new-file case, and the line anchors.
 */
import { describe, expect, it } from 'vitest';
import { computeChanges, anchorLine, changeCoversLine } from '../diff-to-changes.js';

describe('computeChanges', () => {
  it('identical content → no changes', () => {
    expect(computeChanges('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
  });

  it('a pure insertion is an added block with empty baseline', () => {
    const [c, ...rest] = computeChanges('a\nb\n', 'a\nX\nb\n');
    expect(rest).toEqual([]);
    expect(c.kind).toBe('added');
    expect(c.baselineText).toBe('');
    expect(c.otherStart).toBe(1); // line "X" is 0-based index 1
    expect(c.otherEnd).toBe(2);
  });

  it('a pure deletion is a deleted block carrying the removed text', () => {
    const [c] = computeChanges('a\nb\nc\n', 'a\nc\n');
    expect(c.kind).toBe('deleted');
    expect(c.baselineText).toBe('b');
    expect(c.otherEnd).toBe(c.otherStart); // no current lines
  });

  it('an edit is a modified block carrying the original text', () => {
    const [c] = computeChanges('a\nb\nc\n', 'a\nB\nc\n');
    expect(c.kind).toBe('modified');
    expect(c.baselineText).toBe('b');
  });

  it('a new file (empty baseline) is one whole-file added block', () => {
    const [c, ...rest] = computeChanges('', 'x\ny\n');
    expect(rest).toEqual([]);
    expect(c.kind).toBe('added');
    expect(c.otherStart).toBe(0);
    expect(c.otherEnd).toBe(2);
  });

  it('reports independent blocks separately', () => {
    const changes = computeChanges('a\nb\nc\nd\n', 'A\nb\nc\nD\n');
    expect(changes.map((c) => c.kind)).toEqual(['modified', 'modified']);
  });
});

describe('anchorLine / changeCoversLine', () => {
  it('anchors added/modified at the first changed line', () => {
    const [c] = computeChanges('a\nb\n', 'a\nX\nb\n');
    expect(anchorLine(c, 3)).toBe(2);
    expect(changeCoversLine(c, 2, 3)).toBe(true);
    expect(changeCoversLine(c, 1, 3)).toBe(false);
  });

  it('anchors a deletion at the line below the gap, clamped at EOF', () => {
    const [mid] = computeChanges('a\nb\nc\n', 'a\nc\n');
    expect(anchorLine(mid, 2)).toBe(2); // line "c"
    const [eof] = computeChanges('a\nb\nc\n', 'a\nb\n');
    expect(anchorLine(eof, 2)).toBe(2); // clamped to last line
    expect(changeCoversLine(eof, 2, 2)).toBe(true);
  });
});
