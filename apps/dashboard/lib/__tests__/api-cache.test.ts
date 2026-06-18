/**
 * Unit tests for the shared GET/read dedup + TTL cache (lib/api-cache.ts).
 * Pure module — no React/DOM. Time is controlled by spying on Date.now.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCached, dedupe, writeThrough, invalidateAll } from '../api-cache.js';

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
