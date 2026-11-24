/**
 * Unit tests for the shared GET/read dedup + TTL cache (lib/api-cache.ts).
 * Pure module — no React/DOM. Time is controlled by spying on Date.now.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCached, dedupe, dedupeInflight, writeThrough, invalidateAll, invalidateRead, invalidateSessionLists } from '../api-cache.js';

const BASE = 1_000_000;
let now = BASE;

beforeEach(() => {
  vi.useFakeTimers();
  invalidateAll();
  now = BASE;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  invalidateAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dedupe', () => {
  it('keeps a post-mutation detail read when a pre-mutation read finishes last', async () => {
    const key = 'GET /api/company/sessions/company-a';
    let finish!: (agents: string[]) => void;
    const before = dedupe(key, () => new Promise<string[]>(resolve => { finish = resolve; }));
    invalidateRead(key);
    await dedupe(key, async () => []);
    finish(['deleted-agent']);
    await before;
    expect(getCached(key)).toEqual([]);
  });
  it('fetches new project and global session lists when a creation races an older GET', async () => {
    const detail = 'GET http://app/api/coder/sessions/parent?tail=120';
    await dedupe(detail, async () => 'transcript');
    for (const key of ['GET http://app/api/coder/sessions?project_id=1', 'GET http://app/api/coder/sessions/global?archived=0']) {
      let finishOld!: (value: string[]) => void, finishNew!: (value: string[]) => void;
      const stale = dedupe(key, () => new Promise<string[]>(resolve => { finishOld = resolve; }));
      invalidateSessionLists();
      const fresh = dedupe(key, () => new Promise<string[]>(resolve => { finishNew = resolve; }));
      finishOld(['parent']);
      await stale;
      expect(getCached(key)).toBeUndefined();
      expect(dedupe(key, async () => [])).toBe(fresh);
      finishNew(['parent', 'child']);
      await fresh;
      expect(getCached(key)).toEqual(['parent', 'child']);
    }
    expect(getCached(detail)).toBe('transcript');
  });

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

describe('bounded retention', () => {
  it('expires even a single untouched body and leaves no idle timer', async () => {
    const deleteEntry = vi.spyOn(Map.prototype, 'delete');
    await dedupe('lonely-body', async () => ({ value: 'resident' }));
    expect(vi.getTimerCount()).toBe(1);
    now = BASE + 1501;
    await vi.advanceTimersByTimeAsync(1501);
    // Verify actual eviction, rather than merely the lazy getCached miss.
    expect(deleteEntry).toHaveBeenCalledWith('lonely-body');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retains more than 64 entries during a fresh burst', async () => {
    for (let i = 0; i < 100; i++) await dedupe(`burst-${i}`, async () => i);
    const live = Array.from({ length: 100 }, (_, i) => getCached(`burst-${i}`)).filter(x => x !== undefined);
    expect(live).toHaveLength(64);
    expect(getCached('burst-0')).toBeUndefined();
    expect(getCached('burst-99')).toBe(99);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('also bounds retained payload bytes below the entry-count limit', async () => {
    const body = 'x'.repeat(60_000);
    for (let i = 0; i < 30; i++) await dedupe(`large-${i}`, async () => body);
    const count = Array.from({ length: 30 }, (_, i) => getCached(`large-${i}`)).filter(x => x !== undefined).length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(18);
    expect(getCached('large-29')).toBe(body);
  });

  it('shares oversized and complex reads without retaining them after settlement', async () => {
    const body = 'x'.repeat(300_000);
    let complete!: (value: string) => void;
    const producer = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const first = dedupe('huge', producer), second = dedupe('huge', producer);
    expect(first).toBe(second); complete(body);
    expect(await first).toBe(body); expect(await second).toBe(body);
    expect(producer).toHaveBeenCalledOnce(); expect(getCached('huge')).toBeUndefined();
    const complex = new Array(100_000).fill(1);
    expect(await dedupe('complex', async () => complex)).toBe(complex);
    expect(getCached('complex')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resurrect expired bodies via optimistic writes', async () => {
    await dedupe('expired', async () => 'old');
    now = BASE + 1501;
    writeThrough('expired', 'new');
    expect(getCached('expired')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a refreshed entry when the old expiry deadline fires', async () => {
    await dedupe('refresh', async () => 'old');
    now = BASE + 1000; writeThrough('refresh', 'new');
    now = BASE + 1501; await vi.advanceTimersByTimeAsync(1501);
    expect(getCached('refresh')).toBe('new');
    now = BASE + 2501; await vi.advanceTimersByTimeAsync(1000);
    expect(getCached('refresh')).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('invalidation keeps a shared request alive without recaching its stale result', async () => {
    let complete!: (value: string) => void;
    const producer = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const first = dedupe('pending', producer);
    invalidateAll();
    const second = dedupe('pending', producer);
    expect(first).toBe(second); complete('old snapshot');
    expect(await first).toBe('old snapshot'); expect(await second).toBe('old snapshot');
    expect(getCached('pending')).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    await dedupe('pending', async () => 'fresh');
    expect(getCached('pending')).toBe('fresh');
  });
});
