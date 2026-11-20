/**
 * End-to-end smoke tests for `WorkerHost` against a real worker_thread.
 *
 * The fixture worker (`fake-worker.mjs`) implements the same protocol
 * as the production `company-worker.ts` but with trivial handlers.
 * This exercises the full path: `new Worker(file)` → boot handshake
 * → bridge `request/emit` round-trip → graceful eviction.
 *
 * Real `worker_threads.Worker` integration. Tests run in vitest's
 * `pool: 'forks'` so the parent process exits cleanly between files.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { WorkerHost } from '../WorkerHost.js';

const fakeWorkerUrl = new URL('./fixtures/fake-worker.mjs', import.meta.url);
const fakeWorkerPath = fileURLToPath(fakeWorkerUrl);

const hosts: WorkerHost[] = [];

afterEach(async () => {
  for (const h of hosts) {
    try { await h.evict(1_000); } catch { /* best-effort */ }
  }
  hosts.length = 0;
});

function makeHost(opts: Partial<ConstructorParameters<typeof WorkerHost>[0]> = {}): WorkerHost {
  const host = new WorkerHost({
    workerFile: fakeWorkerPath,
    name: 'test',
    maxRestarts: 1,
    restartBackoffMs: 10,
    defaultRequestTimeoutMs: 2_000,
    ...opts,
  });
  hosts.push(host);
  return host;
}

describe('WorkerHost ↔ real worker_threads', () => {
  it('boots, signals ready, processes an RPC round-trip', async () => {
    const host = makeHost();
    await host.start();
    expect(host.isRunning()).toBe(true);
    const reply = await host.requireBridge().request<{ pong: string }>('ping', { value: 'hi' });
    expect(reply).toEqual({ pong: 'hi' });
  });

  it('forwards events from worker → main', async () => {
    const host = makeHost();
    await host.start();
    const ticks: unknown[] = [];
    host.requireBridge().on('tick', (payload) => ticks.push(payload));
    // The fixture emits one `tick` 50ms after boot.
    await new Promise((r) => setTimeout(r, 150));
    expect(ticks).toEqual([{ tick: 1 }]);
  });

  it('forwards per-isolate resource limits to the worker', async () => {
    const host = makeHost({ resourceLimits: { maxOldGenerationSizeMb: 64 } });
    await host.start();
    const stats = await host.requireBridge().request<{ heapLimitMB: number }>('heapLimit', {});
    expect(stats.heapLimitMB).toBeLessThan(256);
  });

  it('surfaces handler errors as rejected promises', async () => {
    const host = makeHost();
    await host.start();
    await expect(
      host.requireBridge().request('throw', { message: 'nope' }),
    ).rejects.toThrow('nope');
  });

  it('honors per-request timeout', async () => {
    const host = makeHost({ defaultRequestTimeoutMs: 30 });
    await host.start();
    await expect(
      host.requireBridge().request('slow', { ms: 200 }, { timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/);
  });

  it('evict() shuts the worker down cleanly', async () => {
    const host = makeHost();
    await host.start();
    expect(host.isRunning()).toBe(true);
    await host.evict(500);
    expect(host.isRunning()).toBe(false);
    expect(host.state).toBe('idle');
  });

  it('reports the actual exit before ready without waiting for the startup timeout', async () => {
    const host = makeHost({ maxRestarts: 0, workerData: { exitBeforeReady: true } });
    await expect(host.start()).rejects.toThrow(/exited.*17.*before.*ready/i);
    expect(host.state).toBe('crashed');
    expect(host.messageBridge).toBeNull();
  }, 3_000);

  it('terminates a worker that never signals ready and allows another start', async () => {
    const data = { skipReady: true };
    const host = makeHost({ readyTimeoutMs: 500, workerData: data });
    await expect(host.start()).rejects.toThrow(/ready/i);
    expect(host.messageBridge).toBeNull();
    data.skipReady = false;
    await host.start();
    expect(host.isRunning()).toBe(true);
  }, 4_000);

  it('stops a boot in progress and waits for the same exit on concurrent eviction', async () => {
    const onExit = vi.fn();
    const host = makeHost({ workerData: { skipReady: true }, onExit });
    const boot = host.start().catch((error: Error) => error);
    const first = host.evict(50);
    await host.evict(50);
    expect(onExit).toHaveBeenCalledExactlyOnceWith(expect.any(Number), true);
    await first;
    expect(await boot).toBeInstanceOf(Error);
    expect(host.state).toBe('idle');
  });

  it('cancels an automatic restart if evicted during backoff', async () => {
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; });
    const host = makeHost({ onExit: exited, restartBackoffMs: 40 });
    await host.start();
    await host.requireBridge().request('exitSoon', {});
    await exit;
    await host.evict();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(host.messageBridge).toBeNull();
    expect(host.state).toBe('idle');
  });

  it('uses one grace deadline when a real worker never acknowledges stop', async () => {
    const host = makeHost({ workerData: { ignoreStop: true } });
    await host.start();
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    vi.useFakeTimers();
    try {
      const stopped = host.evict(250);
      await vi.advanceTimersByTimeAsync(250);
      expect(terminate).toHaveBeenCalledOnce();
      await stopped;
      expect(host.messageBridge).toBeNull();
    } finally {
      vi.useRealTimers();
      terminate.mockRestore();
    }
  });

  it('retains the real isolate if termination fails so shutdown can be retried', async () => {
    const host = makeHost();
    await host.start();
    const termination = vi.spyOn(Worker.prototype, 'terminate').mockRejectedValueOnce(new Error('temporary termination failure'));
    try {
      await expect(host.evict(75)).rejects.toThrow('temporary termination failure');
      expect(await host.requireBridge().request('ping', { value: 'still alive' })).toEqual({ pong: 'still alive' });
      await host.evict(75);
      expect(host.state).toBe('idle');
    } finally { termination.mockRestore(); }
  });
});
