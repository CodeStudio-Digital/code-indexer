/**
 * Bug B regression — structural progress must be MONOTONIC under concurrency.
 *
 * `withConcurrency` finishes files out of enqueue order, so reporting the
 * enqueue index (`idx + 1`) made the progress bar jump forward AND backward.
 * `runStructuralIndex` now counts COMPLETIONS instead. These tests prove the
 * completed-counter pattern is monotonic even when later-enqueued files finish
 * first, and document the buggy enqueue-index behaviour it replaced.
 */
import { describe, expect, it } from 'vitest';
import { withConcurrency } from '../indexer/enrich-references.js';
import { resolveStructuralWriteSchedule } from '../structural.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('structural progress (Bug B)', () => {
  // Reverse delays: the LAST-enqueued item resolves FIRST. With concurrency
  // covering all items, completion order is the exact reverse of enqueue order.
  const items = [50, 40, 30, 20, 10, 0];

  it('reports monotonic `current` via a completion counter', async () => {
    const progress: number[] = [];
    let completed = 0;
    await withConcurrency(items, async (ms) => {
      await delay(ms);
      progress.push(++completed); // the fix: count files as they finish
    }, items.length);

    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress).toEqual([...progress].sort((a, b) => a - b)); // non-decreasing
    expect(progress.at(-1)).toBe(items.length);
  });

  it('the old enqueue-index report would NOT be monotonic', async () => {
    const byIndex: number[] = [];
    await withConcurrency(items, async (ms, idx) => {
      await delay(ms);
      byIndex.push(idx + 1); // the bug
    }, items.length);

    // Completion is reversed → the buggy sequence is strictly decreasing,
    // i.e. not ascending-sorted. Pins exactly what we fixed.
    expect(byIndex).not.toEqual([...byIndex].sort((a, b) => a - b));
  });
});

describe('structural central-writer fairness', () => {
  it('serializes and yields every central-DB file', () => {
    expect(resolveStructuralWriteSchedule(false, 5)).toEqual({
      concurrency: 1,
      yieldEvery: 1,
    });
  });

  it('retains requested concurrency for an isolated project DB', () => {
    expect(resolveStructuralWriteSchedule(true, 5)).toEqual({
      concurrency: 5,
      yieldEvery: 50,
    });
  });
});
