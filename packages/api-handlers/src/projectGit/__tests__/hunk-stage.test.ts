/**
 * Pure tests for partial-hunk selection (no git). Verifies header parsing and
 * that selectHunks keeps exactly the hunks whose new-side range overlaps the
 * requested line range, dropping the rest and the binary (no-@@) case.
 */
import { describe, expect, it } from 'vitest';
import { parseHunkHeader, selectHunks } from '../hunk-stage.js';

const PATCH = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '@@ -10,2 +10,3 @@',
  ' j',
  '+NEW',
  ' k',
  '',
].join('\n');

describe('parseHunkHeader', () => {
  it('parses start + count', () => {
    expect(parseHunkHeader('@@ -1,3 +4,5 @@')).toEqual({ newStart: 4, newCount: 5 });
  });
  it('defaults omitted count to 1', () => {
    expect(parseHunkHeader('@@ -5 +5 @@')).toEqual({ newStart: 5, newCount: 1 });
  });
  it('returns null on a non-header line', () => {
    expect(parseHunkHeader(' context')).toBeNull();
  });
});

describe('selectHunks', () => {
  it('keeps only the hunk overlapping the requested range', () => {
    const out = selectHunks(PATCH, 1, 1)!;
    expect(out).toContain('@@ -1,3 +1,3 @@');
    expect(out).not.toContain('@@ -10,2 +10,3 @@');
    expect(out).toContain('--- a/f.txt'); // header preserved
    expect(out).toContain('+B');
  });

  it('selects the second hunk for a later range', () => {
    const out = selectHunks(PATCH, 11, 11)!;
    expect(out).toContain('@@ -10,2 +10,3 @@');
    expect(out).not.toContain('@@ -1,3 +1,3 @@');
    expect(out).toContain('+NEW');
  });

  it('keeps both when the range spans them', () => {
    const out = selectHunks(PATCH, 1, 99)!;
    expect(out).toContain('@@ -1,3 +1,3 @@');
    expect(out).toContain('@@ -10,2 +10,3 @@');
  });

  it('returns null when nothing overlaps', () => {
    expect(selectHunks(PATCH, 100, 100)).toBeNull();
  });

  it('returns null for a binary patch (no hunks)', () => {
    expect(selectHunks('Binary files a/x and b/x differ\n', 1, 1)).toBeNull();
  });
});
