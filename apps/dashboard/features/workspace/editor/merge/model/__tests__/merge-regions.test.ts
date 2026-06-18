/**
 * Pure tests for the 3-way merge model (no Monaco). Validates region
 * classification, the marker-free Result seed, and the load-bearing rule
 * that adjacent-but-independent edits do NOT collapse into a false conflict.
 */
import { describe, expect, it } from 'vitest';
import { splitLines, diffLines } from '../line-diff.js';
import { computeMergeRegions } from '../merge-regions.js';
import { buildInitialResult, detectEol } from '../build-result.js';
import type { RegionKind, RegionSide } from '../types.js';

const kinds = (b: string | null, o: string | null, t: string | null): RegionKind[] =>
  computeMergeRegions(b, o, t).regions.map((r) => r.kind);
const result = (b: string | null, o: string | null, t: string | null, hint?: { eol: '\n' | '\r\n'; finalNewline: boolean }): string =>
  buildInitialResult(computeMergeRegions(b, o, t), hint).text;

describe('splitLines / diffLines', () => {
  it('splits dropping the trailing-newline artifact', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
  it('equal files → one equal segment', () => {
    const segs = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(segs).toEqual([{ kind: 'equal', baseStart: 0, baseEnd: 3, otherStart: 0, otherEnd: 3 }]);
  });
  it('CRLF aligns identically to its LF twin', () => {
    expect(diffLines('a\r\nb\r\nc', 'a\nX\nc')).toEqual(diffLines('a\nb\nc', 'a\nX\nc'));
  });
  it('empty↔content is a single insert/delete', () => {
    expect(diffLines('', 'a\nb').map((s) => s.kind)).toEqual(['insert']);
    expect(diffLines('a\nb', '').map((s) => s.kind)).toEqual(['delete']);
  });
});

describe('computeMergeRegions', () => {
  it('unchanged file → one unchanged region, no changes', () => {
    const m = computeMergeRegions('a\nb\n', 'a\nb\n', 'a\nb\n');
    expect(m.regions.map((r) => r.kind)).toEqual(['unchanged']);
    expect(m.changeCount).toBe(0);
    expect(m.conflictCount).toBe(0);
  });
  it('ours-only change → oursOnly, Result === ours', () => {
    const b = 'a\nb\nc\n', o = 'a\nB\nc\n', t = 'a\nb\nc\n';
    expect(kinds(b, o, t)).toContain('oursOnly');
    expect(computeMergeRegions(b, o, t).conflictCount).toBe(0);
    expect(result(b, o, t)).toBe(o);
  });
  it('theirs-only change → theirsOnly, Result === theirs', () => {
    const b = 'a\nb\nc\n', o = 'a\nb\nc\n', t = 'a\nb\nT\n';
    expect(kinds(b, o, t)).toContain('theirsOnly');
    expect(result(b, o, t)).toBe(t);
  });
  it('both change the SAME line differently → conflict, Result seeds ours, no markers', () => {
    const b = 'a\nb\nc\n', o = 'a\nX\nc\n', t = 'a\nY\nc\n';
    const m = computeMergeRegions(b, o, t);
    expect(m.conflictCount).toBe(1);
    expect(m.regions.find((r) => r.kind === 'conflict')?.unresolved).toBe(true);
    const text = result(b, o, t);
    expect(text).toBe(o); // seeded to ours
    expect(text).not.toContain('<<<<<<<');
  });
  it('both make the IDENTICAL change → bothSame, not a conflict', () => {
    const b = 'a\nb\nc\n', same = 'a\nZ\nc\n';
    const m = computeMergeRegions(b, same, same);
    expect(m.regions.map((r) => r.kind)).toContain('bothSame');
    expect(m.conflictCount).toBe(0);
    expect(result(b, same, same)).toBe(same);
  });
  it('interleaved disjoint changes (ours top, theirs bottom) auto-merge', () => {
    const b = 'a\nb\nc\nd\ne\n', o = 'a\nB\nc\nd\ne\n', t = 'a\nb\nc\nD\ne\n';
    expect(computeMergeRegions(b, o, t).conflictCount).toBe(0);
    expect(result(b, o, t)).toBe('a\nB\nc\nD\ne\n');
  });
  it('ADJACENT independent changes do NOT conflict (ours line2, theirs line3)', () => {
    const b = 'a\nb\nc\nd\n', o = 'a\nB\nc\nd\n', t = 'a\nb\nC\nd\n';
    const m = computeMergeRegions(b, o, t);
    expect(m.conflictCount).toBe(0); // must auto-merge, never collapse into one conflict
    expect(result(b, o, t)).toBe('a\nB\nC\nd\n');
  });
  it('overlapping changes on the same line → conflict', () => {
    const b = 'a\nb\nc\n', o = 'a\nB1\nc\n', t = 'a\nB2\nc\n';
    expect(computeMergeRegions(b, o, t).conflictCount).toBe(1);
  });
  it('add/add (no base): differing → conflict; identical → bothSame', () => {
    expect(computeMergeRegions(null, 'x\ny\n', 'x\nz\n').mode).toBe('addAdd');
    expect(computeMergeRegions(null, 'x\ny\n', 'x\nz\n').conflictCount).toBe(1);
    expect(computeMergeRegions(null, 'x\ny\n', 'x\ny\n').conflictCount).toBe(0);
  });
  it('modify/delete (ours deleted) → modifyDelete mode, one conflict', () => {
    const m = computeMergeRegions('a\nb\nc\n', null, 'a\nB\nc\n');
    expect(m.mode).toBe('modifyDelete');
    expect(m.conflictCount).toBe(1);
  });
  it('modify/delete (theirs deleted) → modifyDelete mode, one conflict', () => {
    const m = computeMergeRegions('a\nb\nc\n', 'a\nB\nc\n', null);
    expect(m.mode).toBe('modifyDelete');
    expect(m.conflictCount).toBe(1);
  });
  it('a pure insertion by one side is oursOnly/theirsOnly', () => {
    const b = 'a\nc\n', o = 'a\nb\nc\n', t = 'a\nc\n';
    expect(kinds(b, o, t)).toContain('oursOnly');
    expect(computeMergeRegions(b, o, t).conflictCount).toBe(0);
    expect(result(b, o, t)).toBe('a\nb\nc\n');
  });
});

describe('model invariants (partition + seed) — fuzz', () => {
  // Seeded LCG so any failure is reproducible.
  const lcg = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // '' is in BOTH pools so the fuzz exercises blank lines (the MERGE-BLANK-1 class).
  const ALPHA = ['a', 'b', 'c', 'd', 'x', 'y', 'z', ''];
  const MUT = ['A', 'B', 'C', 'X', ''];
  const pick = (rnd: () => number, arr: string[]) => arr[Math.floor(rnd() * arr.length)];
  const genLines = (rnd: () => number, n: number) => Array.from({ length: n }, () => pick(rnd, ALPHA));
  const mutate = (rnd: () => number, lines: string[]): string[] => {
    const out = [...lines];
    const ops = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < ops; k++) {
      if (out.length === 0 || rnd() < 0.34) out.splice(Math.floor(rnd() * (out.length + 1)), 0, pick(rnd, MUT));
      else if (rnd() < 0.5) out.splice(Math.floor(rnd() * out.length), 1);
      else out[Math.floor(rnd() * out.length)] = pick(rnd, MUT);
    }
    return out;
  };
  const join = (lines: string[]) => (lines.length ? lines.join('\n') + '\n' : '');
  // Each source's region side-texts, concatenated in order, must equal the source
  // (no loss/dup/reorder). Filter by the SPAN (a 1-blank-line region has text='' but
  // a real line) — NOT by text!=='' which would mask dropped blank lines.
  const reconstruct = (
    regions: { ours: RegionSide; theirs: RegionSide; base: RegionSide }[],
    key: 'ours' | 'theirs' | 'base',
  ) => regions.filter((r) => r[key].endLine >= r[key].startLine).map((r) => r[key].text).join('\n');

  it('side ranges partition each source; seed equals the changed side when the other == base', () => {
    const rnd = lcg(12345);
    for (let trial = 0; trial < 3000; trial++) {
      const base = genLines(rnd, Math.floor(rnd() * 6));
      const ours = mutate(rnd, base);
      const theirs = mutate(rnd, base);
      const bS = join(base), oS = join(ours), tS = join(theirs);
      const m = computeMergeRegions(bS, oS, tS);
      expect(reconstruct(m.regions, 'ours')).toBe(ours.join('\n'));
      expect(reconstruct(m.regions, 'theirs')).toBe(theirs.join('\n'));
      expect(reconstruct(m.regions, 'base')).toBe(base.join('\n'));
      // theirs untouched → the auto-merge seed must be exactly ours (and vice-versa).
      if (tS === bS) expect(buildInitialResult(m, detectEol(oS)).text).toBe(oS);
      if (oS === bS) expect(buildInitialResult(m, detectEol(tS)).text).toBe(tS);
    }
  });

  it('regression: trailing delete does not duplicate lines in the seed (MERGE-1)', () => {
    expect(buildInitialResult(computeMergeRegions('c\na\nc\n', 'Y\na\n', 'c\na\nc\n')).text).toBe('Y\na\n');
  });

  it('regression: a pure insert before a change is not double-counted (MERGE-2)', () => {
    expect(result('a\nb\nc\n', 'a\nINS\nb\nc\n', 'a\nB\nc\n')).toBe('a\nINS\nB\nc\n');
  });

  // MERGE-BLANK-1: a single blank line must not be conflated with "0 lines".
  it('regression: a blank line inserted by one side survives the seed', () => {
    expect(result('a\nc\n', 'a\n\nc\n', 'a\nc\n')).toBe('a\n\nc\n');
  });
  it('regression: replacing a line with a blank line survives the seed', () => {
    expect(result('a\nb\nc\n', 'a\n\nc\n', 'a\nb\nc\n')).toBe('a\n\nc\n');
  });
  it('regression: a single-blank-line insert is a change, not unchanged', () => {
    expect(computeMergeRegions('a\nc\n', 'a\n\nc\n', 'a\nc\n').changeCount).toBe(1);
  });
});

describe('buildInitialResult', () => {
  it('region result ranges are contiguous and cover the whole seed', () => {
    const m = computeMergeRegions('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a\nb\nc\nD\n');
    const { text, regionResultRanges } = buildInitialResult(m);
    const totalLines = text.replace(/\n$/, '').split('\n').length;
    const covered = regionResultRanges.reduce((n, r) => n + Math.max(0, r.endLine - r.startLine + 1), 0);
    expect(covered).toBe(totalLines);
  });
  it('no trailing newline is preserved (EOF change)', () => {
    const b = 'a\nb', o = 'a\nB', t = 'a\nb';
    expect(result(b, o, t, detectEol(o))).toBe('a\nB'); // no trailing \n
  });
  it('re-applies the dominant CRLF EOL', () => {
    const b = 'a\r\nb\r\n', o = 'a\r\nB\r\n', t = 'a\r\nb\r\n';
    expect(result(b, o, t, detectEol(o))).toBe('a\r\nB\r\n');
  });
});
