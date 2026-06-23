import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIdleResource } from '../idle-disposer.js';

interface Fake { id: number }

function makeCounters() {
  let created = 0;
  let destroyed = 0;
  const create = vi.fn(async (): Promise<Fake> => ({ id: ++created }));
  const destroy = vi.fn(async (_res: Fake): Promise<void> => { destroyed++; });
  return {
    create, destroy,
    get created() { return created; },
    get destroyed() { return destroyed; },
  };
}

describe('createIdleResource', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('creates lazily and only once under concurrent acquires', async () => {
    const c = makeCounters();
    const lease = createIdleResource<Fake>({ name: 't', idleTtlMs: 1000, create: c.create, destroy: c.destroy });
    expect(lease.isLoaded()).toBe(false);
    const results = await Promise.all([
      lease.acquire(async (r) => r.id),
      lease.acquire(async (r) => r.id),
      lease.acquire(async (r) => r.id),
    ]);
    expect(results).toEqual([1, 1, 1]);
    expect(c.create).toHaveBeenCalledTimes(1);
    expect(lease.isLoaded()).toBe(true);
  });

  it('evicts after the idle TTL and recreates on next acquire', async () => {
    const c = makeCounters();
    const evicted: string[] = [];
    const lease = createIdleResource<Fake>({
      name: 't', idleTtlMs: 1000, create: c.create, destroy: c.destroy,
      onEvict: (reason) => evicted.push(reason),
    });
    await lease.acquire(async (r) => r.id);
    await vi.advanceTimersByTimeAsync(1001);
    expect(c.destroy).toHaveBeenCalledTimes(1);
    expect(evicted).toEqual(['idle']);
    expect(lease.isLoaded()).toBe(false);
    const id = await lease.acquire(async (r) => r.id);
    expect(id).toBe(2); // fresh instance
  });

  it('does not evict while an acquire is in flight', async () => {
    const c = makeCounters();
    const lease = createIdleResource<Fake>({ name: 't', idleTtlMs: 1000, create: c.create, destroy: c.destroy });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const pending = lease.acquire(async () => { await gate; return 'done'; });
    await vi.advanceTimersByTimeAsync(5000); // way past TTL while fn is pending
    expect(c.destroy).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(1001); // idle clock starts after release
    expect(c.destroy).toHaveBeenCalledTimes(1);
  });

  it('resets the idle timer on each new acquire', async () => {
    const c = makeCounters();
    const lease = createIdleResource<Fake>({ name: 't', idleTtlMs: 1000, create: c.create, destroy: c.destroy });
    await lease.acquire(async (r) => r.id);
    await vi.advanceTimersByTimeAsync(900);
    await lease.acquire(async (r) => r.id); // re-arms
    await vi.advanceTimersByTimeAsync(900);
    expect(c.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(101);
    expect(c.destroy).toHaveBeenCalledTimes(1);
  });

  it('never evicts when idleTtlMs is 0', async () => {
    const c = makeCounters();
    const lease = createIdleResource<Fake>({ name: 't', idleTtlMs: 0, create: c.create, destroy: c.destroy });
    await lease.acquire(async (r) => r.id);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(c.destroy).not.toHaveBeenCalled();
    expect(lease.isLoaded()).toBe(true);
  });

  it('dispose during a pending create waits, then destroys exactly once', async () => {
    let resolveCreate!: (r: Fake) => void;
    const create = vi.fn(() => new Promise<Fake>((r) => { resolveCreate = r; }));
    const destroy = vi.fn();
    const lease = createIdleResource<Fake>({ name: 't', idleTtlMs: 0, create, destroy });
    const order: string[] = [];
    const user = lease.acquire(async () => { order.push('fn'); return 1; });
    const disposal = lease.dispose().then(() => order.push('disposed'));
    resolveCreate({ id: 1 });
    await Promise.all([user, disposal]);
    expect(order).toEqual(['fn', 'disposed']); // in-flight user finished BEFORE destroy
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('dispose is idempotent and allows lazy re-creation afterwards', async () => {
    const c = makeCounters();
    const lease = createIdleResource<Fake>({ name: 't', idleTtlMs: 0, create: c.create, destroy: c.destroy });
    await lease.acquire(async (r) => r.id);
    await Promise.all([lease.dispose(), lease.dispose()]);
    await lease.dispose();
    expect(c.destroy).toHaveBeenCalledTimes(1);
    const id = await lease.acquire(async (r) => r.id);
    expect(id).toBe(2);
  });

  it('does not memoize a failed create — next acquire retries', async () => {
    let calls = 0;
    const create = vi.fn(async (): Promise<Fake> => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return { id: calls };
    });
    const destroy = vi.fn();
    const lease = createIdleResource<Fake>({ name: 't', idleTtlMs: 0, create, destroy });
    await expect(lease.acquire(async (r) => r.id)).rejects.toThrow('boom');
    expect(lease.isLoaded()).toBe(false);
    await expect(lease.acquire(async (r) => r.id)).resolves.toBe(2);
  });

  it('acquire arriving during dispose waits and gets a fresh instance', async () => {
    const c = makeCounters();
    let releaseUser!: () => void;
    const gate = new Promise<void>((r) => { releaseUser = r; });
    const lease = createIdleResource<Fake>({ name: 't', idleTtlMs: 0, create: c.create, destroy: c.destroy });
    const user = lease.acquire(async (r) => { await gate; return r.id; });
    const disposal = lease.dispose();
    const late = lease.acquire(async (r) => r.id); // must wait out the dispose
    releaseUser();
    await Promise.all([user, disposal]);
    await expect(late).resolves.toBe(2);
    expect(c.destroy).toHaveBeenCalledTimes(1);
  });
});
