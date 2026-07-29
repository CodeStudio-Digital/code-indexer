/**
 * Unit tests for the shared GET/read dedup + TTL cache (lib/api-cache.ts).
 * Pure module — no React/DOM. Time is controlled by spying on Date.now.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCached, dedupe, dedupeInflight, writeThrough, invalidateAll } from '../api-cache.js';

const BASE = 1_000_000;
let now = BASE;

beforeEach(() => {
  invalidateAll();
  now = BASE;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dedupe', () => {
  it('collapses concurrent identical calls into one producer invocation', async () => {
    let calls = 0;
    const producer = () => {
      calls++;
      return Promise.resolve('value');
    };
    const p1 = dedupe('k', producer);
    const p2 = dedupe('k', producer); // joins the in-flight promise
    expect(calls).toBe(1);
    expect(await p1).toBe('value');
    expect(await p2).toBe('value');
  });

  it('caches the resolved value (served within TTL)', async () => {
    await dedupe('k', () => Promise.resolve(42));
    expect(getCached<number>('k')).toBe(42);
  });

  it('does NOT cache rejected producers and clears the in-flight slot (retry works)', async () => {
    let calls = 0;
    const bad = () => {
      calls++;
      return Promise.reject(new Error('boom'));
    };
    await expect(dedupe('e', bad)).rejects.toThrow('boom');
    expect(getCached('e')).toBeUndefined();
    // in-flight slot cleared → a subsequent call re-invokes the producer
    await expect(dedupe('e', bad)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});

describe('dedupeInflight', () => {
  it('collapses concurrent identical calls into one producer invocation', async () => {
    let calls = 0;
    const producer = () => {
      calls++;
      return Promise.resolve('v');
    };
    const p1 = dedupeInflight('k', producer);
    const p2 = dedupeInflight('k', producer); // joins the live promise
    expect(calls).toBe(1);
    expect(await p1).toBe('v');
    expect(await p2).toBe('v');
  });

  it('does NOT cache the body — the next call after settle re-fetches', async () => {
    let calls = 0;
    const producer = () => {
      calls++;
      return Promise.resolve('v');
    };
    await dedupeInflight('k', producer);
    expect(getCached('k')).toBeUndefined(); // never written to the TTL cache
    await dedupeInflight('k', producer); // slot cleared on settle → re-invokes
    expect(calls).toBe(2);
  });

  it('clears the in-flight slot on rejection (retry works)', async () => {
    let calls = 0;
    const bad = () => {
      calls++;
      return Promise.reject(new Error('boom'));
    };
    await expect(dedupeInflight('e', bad)).rejects.toThrow('boom');
    await expect(dedupeInflight('e', bad)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});

describe('getCached TTL', () => {
  it('serves at the TTL boundary and expires just past it', async () => {
    await dedupe('k', () => Promise.resolve('v')); // stored at now=BASE
    now = BASE + 1500; // exactly TTL → still valid (expiry is strictly greater)
    expect(getCached('k')).toBe('v');
    now = BASE + 1501; // past TTL → expired
    expect(getCached('k')).toBeUndefined();
  });

  it('treats an empty key as a no-op (never a hit)', () => {
    expect(getCached('')).toBeUndefined();
  });
});

describe('invalidateAll', () => {
  it('drops every cached entry', async () => {
    await dedupe('a', () => Promise.resolve(1));
    await dedupe('b', () => Promise.resolve(2));
    invalidateAll();
    expect(getCached('a')).toBeUndefined();
    expect(getCached('b')).toBeUndefined();
  });
});

describe('writeThrough', () => {
  it('refreshes an already-live entry', async () => {
    await dedupe('w', () => Promise.resolve(1));
    writeThrough('w', 2);
    expect(getCached<number>('w')).toBe(2);
  });

  it('does not resurrect a missing/expired key', () => {
    writeThrough('ghost', 9);
    expect(getCached('ghost')).toBeUndefined();
  });
});

describe('expired-entry sweep', () => {
  /**
   * `writeThrough` is the probe for residency: it refreshes a key only when the
   * entry is still PRESENT in the map, regardless of age. So a key that a sweep
   * removed can no longer be revived by it, while a key still resident can —
   * which distinguishes "evicted" from merely "expired" through the public API.
   */
  const fill = async (count: number, prefix: string) => {
    for (let i = 0; i < count; i++) {
      await dedupe(`${prefix}${i}`, () => Promise.resolve(i));
    }
  };

  it('evicts entries whose TTL lapsed once the cache grows past the sweep size', async () => {
    await fill(64, 'old');
    // Still resident at this point: writeThrough can refresh them.
    writeThrough('old0', 'refreshed');
    expect(getCached('old0')).toBe('refreshed');

    now = BASE + 5_000; // every 'old*' entry is now past its TTL
    await dedupe('trigger', () => Promise.resolve('x')); // pushes size over the threshold

    writeThrough('old0', 'resurrected');
    expect(getCached('old0')).toBeUndefined();
    writeThrough('old63', 'resurrected');
    expect(getCached('old63')).toBeUndefined();
  });

  it('keeps still-fresh entries when the sweep runs', async () => {
    await fill(64, 'stale');
    now = BASE + 5_000;
    await dedupe('fresh', () => Promise.resolve('kept'));
    // 'fresh' was written at the same instant as the sweep — it must survive.
    expect(getCached('fresh')).toBe('kept');
    writeThrough('fresh', 'still-there');
    expect(getCached('fresh')).toBe('still-there');
  });

  it('leaves a small cache alone (no sweep below the threshold)', async () => {
    await dedupe('lonely', () => Promise.resolve(1));
    now = BASE + 5_000;
    await dedupe('other', () => Promise.resolve(2)); // size 2 — under the threshold

    // Expired but NOT evicted, so the entry is still resident and writeThrough
    // can refresh it. This is what pins the threshold gate: with an
    // unconditional sweep the key would be gone and this would read undefined.
    writeThrough('lonely', 'refreshed');
    expect(getCached('lonely')).toBe('refreshed');
  });
});
