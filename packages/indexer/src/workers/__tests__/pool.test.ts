/**
 * Integration tests for the worker pool against a real worker_threads
 * fixture (.cjs — Worker cannot load .ts under vitest). Idle/respawn cases
 * use REAL timers: fake timers do not cooperate with worker events.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createPool, resolveWorkerSpec, type Pool } from '../pool.js';

const fixtureUrl = new URL('./fixtures/test-worker.cjs', import.meta.url);

type Req = { cmd: 'echo' | 'slow' | 'fail' | 'crash'; payload?: unknown; delayMs?: number };

const pools: Array<Pool<Req, unknown>> = [];

function makePool(opts?: { size?: number; idleTtlMs?: number; maxQueue?: number; bootCrash?: boolean; respawn?: { baseDelayMs?: number; maxConsecutiveFailures?: number } }): Pool<Req, unknown> {
  const pool = createPool<Req, unknown>({
    workerUrl: fixtureUrl,
    size: opts?.size ?? 1,
    name: 'test',
    idleTtlMs: opts?.idleTtlMs ?? 0,
    maxQueue: opts?.maxQueue,
    respawn: opts?.respawn ?? { baseDelayMs: 1 },
    workerData: opts?.bootCrash ? { bootCrash: true } : undefined,
  });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map((p) => p.close()));
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('worker pool', () => {
  it('recognizes a tsx source URL with a cache-busting query', () => {
    const spec = resolveWorkerSpec('file:///D:/repo/indexJob/client.ts?tsx=1', './worker');
    expect(spec.bootstrapData?.tsEntry.replace(/\\/g, '/')).toBe('D:/repo/indexJob/worker.ts');
  });

  it('spawns lazily and round-trips requests', async () => {
    const pool = makePool({ size: 2 });
    expect(pool.size()).toBe(0); // nothing spawned before first dispatch
    const res = await pool.dispatch({ cmd: 'echo', payload: 'hello' });
    expect(res).toBe('hello');
    expect(pool.size()).toBe(2);
    const many = await Promise.all(
      Array.from({ length: 10 }, (_, i) => pool.dispatch({ cmd: 'echo', payload: i })),
    );
    expect(many).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('propagates worker-side errors with their code', async () => {
    const pool = makePool();
    await expect(pool.dispatch({ cmd: 'fail' })).rejects.toMatchObject({ message: 'fake failure', code: 'FAKE' });
  });

  it('a crash rejects in-flight requests and the pool respawns for the next dispatch', async () => {
    const pool = makePool({ size: 1 });
    await pool.dispatch({ cmd: 'echo', payload: 'warmup' }); // worker is ready
    const slow = pool.dispatch({ cmd: 'slow', payload: 'late', delayMs: 200 });
    slow.catch(() => {}); // observed below — silence the late-handler warning
    const crash = pool.dispatch({ cmd: 'crash' });
    await expect(crash).rejects.toThrow(/worker exited/);
    await expect(slow).rejects.toThrow(/worker exited/);
    const after = await pool.dispatch({ cmd: 'echo', payload: 'recovered' });
    expect(after).toBe('recovered');
  });

  it('a boot-crash loop degrades the pool with POOL_DEGRADED', async () => {
    const pool = makePool({ bootCrash: true, respawn: { baseDelayMs: 1, maxConsecutiveFailures: 2 } });
    await expect(pool.dispatch({ cmd: 'echo', payload: 'x' })).rejects.toMatchObject({ code: 'POOL_DEGRADED' });
    await expect(pool.dispatch({ cmd: 'echo', payload: 'y' })).rejects.toMatchObject({ code: 'POOL_DEGRADED' });
  });

  it('drain resolves when the last outstanding request settles', async () => {
    const pool = makePool();
    await pool.dispatch({ cmd: 'echo', payload: 'warmup' });
    const t0 = Date.now();
    const slow = pool.dispatch({ cmd: 'slow', payload: 'z', delayMs: 80 });
    await pool.drain();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    await expect(slow).resolves.toBe('z');
    await pool.drain(); // empty drain resolves immediately
  });

  it('close waits for in-flight work, then dispatch rejects; close is idempotent', async () => {
    const pool = makePool();
    await pool.dispatch({ cmd: 'echo', payload: 'warmup' }); // worker ready → slow goes straight to in-flight
    const slow = pool.dispatch({ cmd: 'slow', payload: 'last', delayMs: 60 });
    await sleep(10);
    await pool.close();
    await expect(slow).resolves.toBe('last');
    await expect(pool.dispatch({ cmd: 'echo' })).rejects.toThrow('pool is closed');
    await pool.close(); // no throw
    expect(pool.size()).toBe(0);
  });

  it('idle TTL terminates workers and the next dispatch respawns', async () => {
    const pool = makePool({ size: 2, idleTtlMs: 80 });
    await pool.dispatch({ cmd: 'echo', payload: 1 });
    expect(pool.size()).toBe(2);
    await sleep(400); // > TTL with margin for slow CI
    expect(pool.size()).toBe(0);
    const res = await pool.dispatch({ cmd: 'echo', payload: 'again' });
    expect(res).toBe('again');
    expect(pool.size()).toBe(2);
  });

  it('rejects with POOL_QUEUE_FULL above maxQueue', async () => {
    const pool = makePool({ maxQueue: 1 });
    const first = pool.dispatch({ cmd: 'echo', payload: 'a' }); // queued while worker boots
    await expect(pool.dispatch({ cmd: 'echo', payload: 'b' })).rejects.toMatchObject({ code: 'POOL_QUEUE_FULL' });
    await expect(first).resolves.toBe('a');
  });
});
