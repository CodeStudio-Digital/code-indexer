/**
 * `mapLimit` replaced several `Promise.all(items.map(...))` calls that were
 * unbounded in practice — a 5k-entry directory queued 5k `fs.stat` against a
 * 4-thread libuv pool, and an SFTP transfer would have opened a channel per
 * file past OpenSSH's MaxSessions. The two properties that matter are pinned
 * here: results stay in INPUT order, and no more than `limit` run at once.
 */
import { describe, expect, it } from 'vitest';
import { mapLimit } from '../map-limit.js';

/** Resolve after `ms` — enough to interleave without making the test slow. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('mapLimit', () => {
  it('preserves input order even when later items finish first', async () => {
    const out = await mapLimit([30, 20, 10, 0], 4, async (ms, i) => {
      await delay(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 30 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(2);
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // …but it IS concurrent, not serialized
  });

  it('actually runs concurrently (faster than serial)', async () => {
    const started: number[] = [];
    await mapLimit([0, 1, 2, 3], 4, async (i) => {
      started.push(i);
      await delay(20);
    });
    // All four entered before any finished → they overlapped.
    expect(started).toHaveLength(4);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1, 2], 100, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('clamps a nonsense limit to at least 1 instead of hanging', async () => {
    expect(await mapLimit([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3]);
    expect(await mapLimit([1, 2, 3], -5, async (n) => n)).toEqual([1, 2, 3]);
  });

  it('rejects like Promise.all and stops handing out new work', async () => {
    let started = 0;
    await expect(
      mapLimit(Array.from({ length: 50 }, (_, i) => i), 2, async (i) => {
        started += 1;
        await delay(1);
        if (i === 1) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');
    // Far fewer than 50 items were attempted — it did not run to completion.
    expect(started).toBeLessThan(50);
  });
});
