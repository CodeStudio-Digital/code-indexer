import { describe, it, expect } from 'vitest';
import { MAX_DP_CELLS, diffOps, splitLines, type EditOp } from '../snapshot-line-diff.js';

/** Reconstruct the "after" side from an edit script: eq + add lines, in order. */
function applyOps(ops: EditOp[]): string[] {
  return ops.filter((o) => o.kind !== 'del').map((o) => o.line);
}

/** Reconstruct the "before" side: eq + del lines, in order. */
function unapplyOps(ops: EditOp[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.line);
}

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`);

describe('diffOps', () => {
  it('produces a minimal edit script for a small change', () => {
    const ops = diffOps(splitLines('a\nb\nc\n'), splitLines('a\nB\nc\n'));
    expect(ops.filter((o) => o.kind === 'del')).toEqual([{ kind: 'del', line: 'b' }]);
    expect(ops.filter((o) => o.kind === 'add')).toEqual([{ kind: 'add', line: 'B' }]);
  });

  it('round-trips both sides', () => {
    const a = splitLines('one\ntwo\nthree\nfour\n');
    const b = splitLines('one\nthree\nfour\nfive\n');
    const ops = diffOps(a, b);
    expect(applyOps(ops)).toEqual(b);
    expect(unapplyOps(ops)).toEqual(a);
  });

  it('handles pure add and pure remove', () => {
    expect(applyOps(diffOps([], splitLines('x\ny\n')))).toEqual(['x', 'y']);
    expect(applyOps(diffOps(splitLines('x\ny\n'), []))).toEqual([]);
  });

  // The prefix/suffix trim is what keeps the common case off the DP entirely:
  // 60k identical lines with one edit in the middle must not build a table.
  it('stays minimal for a one-line edit in a very large file', () => {
    const a = lines(60_000);
    const b = [...a];
    b[30_000] = 'CHANGED';

    const started = process.hrtime.bigint();
    const ops = diffOps(a, b);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(ops.filter((o) => o.kind === 'del')).toEqual([{ kind: 'del', line: 'l30000' }]);
    expect(ops.filter((o) => o.kind === 'add')).toEqual([{ kind: 'add', line: 'CHANGED' }]);
    // Without the trim this pair alone is 3.6e9 cells (~14 GB). With it, the
    // middle is 1x1 and this is a linear scan.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  // Regression: the DP table used to be allocated unconditionally, so two
  // unrelated large files asked for gigabytes on the Electron main thread.
  it('degrades to a coarse replace instead of allocating past MAX_DP_CELLS', () => {
    const a = lines(3_000, 'a');
    const b = lines(3_000, 'b');
    // No common prefix/suffix, so the middle is the whole thing.
    expect((a.length + 1) * (b.length + 1)).toBeGreaterThan(MAX_DP_CELLS);

    const started = process.hrtime.bigint();
    const ops = diffOps(a, b);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Coarse but still correct: applying the script reproduces each side.
    expect(applyOps(ops)).toEqual(b);
    expect(unapplyOps(ops)).toEqual(a);
    expect(ops.filter((o) => o.kind === 'eq')).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('still trims shared context around an oversized middle', () => {
    const head = lines(10, 'h');
    const tail = lines(10, 't');
    const a = [...head, ...lines(3_000, 'a'), ...tail];
    const b = [...head, ...lines(3_000, 'b'), ...tail];
    const ops = diffOps(a, b);

    expect(applyOps(ops)).toEqual(b);
    expect(unapplyOps(ops)).toEqual(a);
    // The 20 shared lines survive as context even though the middle degraded.
    expect(ops.filter((o) => o.kind === 'eq')).toHaveLength(20);
  });
});
