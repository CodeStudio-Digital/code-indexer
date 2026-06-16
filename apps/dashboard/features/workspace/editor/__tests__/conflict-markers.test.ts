/**
 * Unit tests for the conflict-region parser — the pure foundation under
 * both the inline resolver and the 3-pane merge editor. (attachConflictUI
 * needs a live Monaco editor and is covered by manual E2E.)
 */
import { describe, expect, it } from 'vitest';
import { parseConflictRegions, hasConflictMarkers } from '../conflict-markers.js';

const TWO_WAY = [
  'before',
  '<<<<<<< HEAD',
  'ours line 1',
  'ours line 2',
  '=======',
  'theirs line 1',
  '>>>>>>> feature',
  'after',
].join('\n');

const DIFF3 = [
  '<<<<<<< ours',
  'our change',
  '||||||| base',
  'common ancestor',
  '=======',
  'their change',
  '>>>>>>> theirs',
].join('\n');

describe('parseConflictRegions', () => {
  it('parses a standard two-way conflict with correct 1-based lines + text', () => {
    const [r, ...rest] = parseConflictRegions(TWO_WAY);
    expect(rest).toHaveLength(0);
    expect(r.startLine).toBe(2); // <<<<<<< is line 2 (1-based)
    expect(r.sepLine).toBe(5);
    expect(r.endLine).toBe(7);
    expect(r.baseLine).toBeUndefined();
    expect(r.currentText).toBe('ours line 1\nours line 2');
    expect(r.incomingText).toBe('theirs line 1');
  });

  it('handles diff3 (|||||||) by excluding the base block from current', () => {
    const [r] = parseConflictRegions(DIFF3);
    expect(r.baseLine).toBe(3);
    expect(r.currentText).toBe('our change'); // stops at the base marker
    expect(r.incomingText).toBe('their change');
  });

  it('finds multiple independent regions', () => {
    const text = `${TWO_WAY}\nmiddle\n${TWO_WAY}`;
    expect(parseConflictRegions(text)).toHaveLength(2);
  });

  it('returns nothing for clean text and reports no markers', () => {
    expect(parseConflictRegions('just\nnormal\ncode\n')).toHaveLength(0);
    expect(hasConflictMarkers('just\nnormal\ncode\n')).toBe(false);
    expect(hasConflictMarkers(TWO_WAY)).toBe(true);
  });

  it('ignores an unterminated marker (no separator/end)', () => {
    expect(parseConflictRegions('<<<<<<< HEAD\norphan\nno end here')).toHaveLength(0);
  });
});
