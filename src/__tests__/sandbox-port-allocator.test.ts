import { describe, it, expect } from 'vitest';
import { PortAllocator } from '@mcp/services/sandbox/port-allocator.js';

// PortAllocator does real TCP binds against 127.0.0.1 inside `acquire()`,
// so tests use a small ephemeral pool (45000–45019) instead of the production
// 34000–34999 range. The pool is intentionally small so we can exercise the
// "exhausted" branch without binding 1000 ports.

describe('PortAllocator — construction', () => {
  it('accepts custom min/max/cooldown', () => {
    const a = new PortAllocator({ min: 45_000, max: 45_010, cooldownMs: 1 });
    expect(a.snapshot()).toEqual({ inUse: [], poolSize: 11 });
  });

  it('throws when min > max', () => {
    expect(() => new PortAllocator({ min: 50, max: 49 })).toThrow(/min .* > max/);
  });

  it('reports poolSize based on the inclusive range', () => {
    const a = new PortAllocator({ min: 45_000, max: 45_099 });
    expect(a.snapshot().poolSize).toBe(100);
  });
});

describe('PortAllocator — acquire / release', () => {
  it('acquires a port in the configured range', async () => {
    const a = new PortAllocator({ min: 45_020, max: 45_039, cooldownMs: 1 });
    const port = await a.acquire();
    expect(port).toBeGreaterThanOrEqual(45_020);
    expect(port).toBeLessThanOrEqual(45_039);
    a.release(port);
  });

  it('marks acquired ports in-use', async () => {
    const a = new PortAllocator({ min: 45_040, max: 45_049, cooldownMs: 1 });
    const port = await a.acquire();
    expect(a.snapshot().inUse).toContain(port);
    a.release(port);
  });

  it('release removes the port from the in-use set', async () => {
    const a = new PortAllocator({ min: 45_050, max: 45_059, cooldownMs: 1 });
    const port = await a.acquire();
    a.release(port);
    expect(a.snapshot().inUse).not.toContain(port);
  });

  it('release is idempotent — calling twice does not throw', async () => {
    const a = new PortAllocator({ min: 45_060, max: 45_069, cooldownMs: 1 });
    const port = await a.acquire();
    a.release(port);
    expect(() => a.release(port)).not.toThrow();
    expect(() => a.release(99_999)).not.toThrow(); // unknown port too
  });

  it('hands out unique ports for concurrent acquires', async () => {
    const a = new PortAllocator({ min: 45_070, max: 45_079, cooldownMs: 1 });
    const [p1, p2, p3] = await Promise.all([a.acquire(), a.acquire(), a.acquire()]);
    expect(new Set([p1, p2, p3]).size).toBe(3);
    a.release(p1);
    a.release(p2);
    a.release(p3);
  });
});

describe('PortAllocator — exhaustion', () => {
  it('throws a descriptive error when no port is available', async () => {
    // Tiny 2-port pool, acquire both then ask for a third.
    const a = new PortAllocator({ min: 45_080, max: 45_081, cooldownMs: 1 });
    const p1 = await a.acquire();
    const p2 = await a.acquire();
    await expect(a.acquire()).rejects.toThrow(/no free port/i);
    a.release(p1);
    a.release(p2);
  });

  it('the error message includes the pool range and in-use count', async () => {
    const a = new PortAllocator({ min: 45_090, max: 45_091, cooldownMs: 1 });
    const p1 = await a.acquire();
    const p2 = await a.acquire();
    await a.acquire().catch((e: Error) => {
      expect(e.message).toContain('[45090, 45091]');
      expect(e.message).toContain('2 in use');
    });
    a.release(p1);
    a.release(p2);
  });
});

describe('PortAllocator — cooldown', () => {
  it('does not immediately reuse a just-released port when cooldown > 0', async () => {
    const a = new PortAllocator({ min: 45_100, max: 45_101, cooldownMs: 5_000 });
    const first = await a.acquire();
    a.release(first);
    // The next acquire must pick the OTHER port in the pool because `first`
    // is in cooldown. With only 2 ports this is observable.
    const second = await a.acquire();
    expect(second).not.toBe(first);
    a.release(second);
  });

  it('reuses a released port immediately when cooldownMs is 0', async () => {
    // 1-port pool with 0ms cooldown — release/acquire cycle must work.
    const a = new PortAllocator({ min: 45_110, max: 45_110, cooldownMs: 0 });
    const first = await a.acquire();
    a.release(first);
    const second = await a.acquire();
    expect(second).toBe(first);
    a.release(second);
  });
});
