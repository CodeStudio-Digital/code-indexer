import { describe, it, expect } from 'vitest';
import { ReadCache } from '../read-cache.js';

/** Controllable clock so TTL behaviour is deterministic (no real time). */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('ReadCache', () => {
  it('computes once and serves the cached value within TTL', () => {
    const clock = fakeClock();
    const cache = new ReadCache(clock.now);
    let calls = 0;
    const read = () => cache.get('stats:1', 1000, () => { calls++; return calls; });

    expect(read()).toBe(1);
    expect(read()).toBe(1); // cached
    expect(calls).toBe(1);

    clock.advance(999);
    expect(read()).toBe(1); // still fresh
    expect(calls).toBe(1);
  });

  it('recomputes after the TTL expires', () => {
    const clock = fakeClock();
    const cache = new ReadCache(clock.now);
    let calls = 0;
    const read = () => cache.get('k', 1000, () => { calls++; return calls; });

    expect(read()).toBe(1);
    clock.advance(1000); // exactly at TTL → expired (strict <)
    expect(read()).toBe(2);
    expect(calls).toBe(2);
  });

  it('caches an undefined value (a negative lookup) within TTL', () => {
    const clock = fakeClock();
    const cache = new ReadCache(clock.now);
    let calls = 0;
    const read = () => cache.get('p:9', 1000, () => { calls++; return undefined; });

    expect(read()).toBeUndefined();
    expect(read()).toBeUndefined();
    expect(calls).toBe(1); // not re-computed despite undefined value
  });

  it('set() overwrites with a fresh value and resets the age (the `fresh` bypass)', () => {
    const clock = fakeClock();
    const cache = new ReadCache(clock.now);
    cache.get('stats:1', 1000, () => 'stale');
    clock.advance(500);
    cache.set('stats:1', 'fresh');
    clock.advance(999); // 999ms since the set → still fresh
    expect(cache.get('stats:1', 1000, () => 'recomputed')).toBe('fresh');
  });

  it('invalidateProject drops only the target project, via last-segment match (real key shapes)', () => {
    const cache = new ReadCache(() => 0);
    cache.set('stats:1', 'a');
    cache.set('stats:2', 'b');   // different project — must NOT be dropped
    cache.set('stats:12', 'c');  // id 12, NOT id 1 — the suffix-collision guard
    cache.set('projects:list', 'd');

    cache.invalidateProject(1);

    let recomputed = false;
    expect(cache.get('stats:1', 1000, () => { recomputed = true; return 'x'; })).toBe('x');
    expect(recomputed).toBe(true);
    expect(cache.get('stats:2', 1000, () => 'should-not-run')).toBe('b'); // untouched
    expect(cache.get('stats:12', 1000, () => 'should-not-run')).toBe('c'); // untouched (not ':1')
    expect(cache.get('projects:list', 1000, () => 'should-not-run')).toBe('d'); // untouched
  });

  it('invalidateKey / clear drop entries', () => {
    const cache = new ReadCache(() => 0);
    cache.set('projects:list', 'd');
    cache.invalidateKey('projects:list');
    expect(cache.get('projects:list', 1000, () => 'rebuilt')).toBe('rebuilt');

    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a', 1000, () => 99)).toBe(99);
  });
});
