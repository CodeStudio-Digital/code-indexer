/**
 * Memory READ-union helpers — pure, no sqlite/LLM. Pins the two behaviours that
 * matter: single project is the IDENTITY path (no label, no re-rank, no cap, so
 * ordinary sessions are byte-equivalent to before), and a multi-project union
 * is labeled + merged.
 */
import { describe, expect, it } from 'vitest';
import {
  perProjectIndexLimit,
  mergeMemoryIndex,
  interleaveLabeled,
  mapProjectsConcurrent,
} from '../union-memory.js';

describe('mapProjectsConcurrent', () => {
  it('preserves order and never runs more than four project reads at once', async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = mapProjectsConcurrent([0, 1, 2, 3, 4, 5], async (value) => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return value * 2;
    });

    await Promise.resolve();
    expect(maximum).toBe(4);
    release();
    await expect(pending).resolves.toEqual([0, 2, 4, 6, 8, 10]);
  });
});

describe('perProjectIndexLimit', () => {
  it('gives the full budget to a single project', () => {
    expect(perProjectIndexLimit(1)).toBe(12);
    expect(perProjectIndexLimit(0)).toBe(12);
  });
  it('splits the budget across a union, with a floor', () => {
    expect(perProjectIndexLimit(2)).toBe(6); // ceil(12/2)
    expect(perProjectIndexLimit(3)).toBe(4); // ceil(12/3)
    expect(perProjectIndexLimit(8)).toBe(4); // floor of 4 even though 12/8=1.5
  });
});

describe('mergeMemoryIndex', () => {
  it('single project: identity (no label, no re-rank, no cap)', () => {
    const entries = [
      { title: 'low', importance: 0.1 },
      { title: 'high', importance: 0.9 },
    ];
    const out = mergeMemoryIndex([{ name: 'solo', entries }]);
    expect(out).toBe(entries); // same reference — untouched
    expect(out.map((e) => e.title)).toEqual(['low', 'high']);
  });

  it('union: labels by project, re-ranks by importance, caps to total', () => {
    const out = mergeMemoryIndex(
      [
        { name: 'API', entries: [{ title: 'a-hi', importance: 0.9 }, { title: 'a-lo', importance: 0.2 }] },
        { name: 'Web', entries: [{ title: 'w-mid', importance: 0.5 }] },
      ],
      2,
    );
    expect(out.map((e) => e.title)).toEqual(['[API] a-hi', '[Web] w-mid']); // a-lo dropped by cap
  });
});

describe('interleaveLabeled', () => {
  it('single project: identity (no label, no cap)', () => {
    const rows = [{ title: 'x' }, { title: 'y' }];
    const out = interleaveLabeled([{ name: 'solo', rows }]);
    expect(out).toBe(rows);
  });

  it('union: round-robin interleave, labeled, capped to limit', () => {
    const out = interleaveLabeled(
      [
        { name: 'A', rows: [{ title: 'a1' }, { title: 'a2' }] },
        { name: 'B', rows: [{ title: 'b1' }] },
      ],
      2,
    );
    expect(out.map((r) => r.title)).toEqual(['[A] a1', '[B] b1']); // a2 dropped by limit
  });

  it('union: no limit returns the full interleave', () => {
    const out = interleaveLabeled([
      { name: 'A', rows: [{ title: 'a1' }, { title: 'a2' }] },
      { name: 'B', rows: [{ title: 'b1' }] },
    ]);
    expect(out.map((r) => r.title)).toEqual(['[A] a1', '[B] b1', '[A] a2']);
  });
});
