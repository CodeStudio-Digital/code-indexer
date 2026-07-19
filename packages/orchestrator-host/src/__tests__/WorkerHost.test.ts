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
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
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
});
