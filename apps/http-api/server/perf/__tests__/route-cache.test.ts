import { describe, it, expect } from 'vitest';
import { RouteCache } from '../route-cache.js';

/** Controllable clock so TTL behaviour is deterministic (no real time). */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('RouteCache', () => {
  it('computes once and serves the cached value within TTL (collapses duplicate polls)', () => {
    const clock = fakeClock();
    const cache = new RouteCache(clock.now);
    let calls = 0;
    const read = () => cache.get('company-snapshot:1', 300, () => { calls++; return calls; });

    expect(read()).toBe(1);
    expect(read()).toBe(1); // the duplicate concurrent poll is served from cache
    expect(calls).toBe(1);

    clock.advance(299);
    expect(read()).toBe(1); // still fresh
    expect(calls).toBe(1);
  });

  it('recomputes after the TTL expires (self-heals to fresh DB state)', () => {
    const clock = fakeClock();
    const cache = new RouteCache(clock.now);
    let calls = 0;
    const read = () => cache.get('k', 300, () => { calls++; return calls; });

    expect(read()).toBe(1);
    clock.advance(300); // exactly at TTL → expired (strict <)
    expect(read()).toBe(2);
    expect(calls).toBe(2);
  });

  it('a ttl of 0 disables caching (every call recomputes — the env kill-switch)', () => {
    const clock = fakeClock();
    const cache = new RouteCache(clock.now);
    let calls = 0;
    const read = () => cache.get('k', 0, () => { calls++; return calls; });

    expect(read()).toBe(1);
    expect(read()).toBe(2); // now()-at < 0 is never true → never a hit
    expect(calls).toBe(2);
  });

  it('caches a null value (a not-found lookup) within TTL', () => {
    const clock = fakeClock();
    const cache = new RouteCache(clock.now);
    let calls = 0;
    const read = () => cache.get('company-snapshot:9', 300, () => { calls++; return null; });

    expect(read()).toBeNull();
    expect(read()).toBeNull();
    expect(calls).toBe(1); // not re-computed despite the null value
  });

  it('invalidate / clear drop entries', () => {
    const cache = new RouteCache(() => 0);
    cache.get('company-snapshot:1', 300, () => 'a');
    cache.invalidate('company-snapshot:1');
    let recomputed = false;
    expect(cache.get('company-snapshot:1', 300, () => { recomputed = true; return 'b'; })).toBe('b');
    expect(recomputed).toBe(true);

    cache.get('a', 300, () => 1);
    cache.clear();
    expect(cache.get('a', 300, () => 99)).toBe(99);
  });
});
