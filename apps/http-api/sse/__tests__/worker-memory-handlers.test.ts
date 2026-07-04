/**
 * Mem C worker bridge — main-side handlers + worker-side shims, exercised
 * against each other through a fake in-memory MessageBridge. Covers the
 * failure posture: missing deps / handler errors must degrade to no-op
 * (empty retrieval, skipped distillation, isConfigured=false) — memory can
 * never break a spawn or a run.
 */
import { describe, expect, it, vi } from 'vitest';
import { registerWorkerMemoryHandlers, type WorkerMemoryDeps } from '../worker-memory-handlers.js';
import { buildWorkerMemoryShims } from '../../workers/memory-shims.js';
import type { MessageBridge } from '../../../../packages/orchestrator-host/src/index.js';

/** Fake bridge: `request` dispatches straight into registered handlers. */
function makeFakeBridge() {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  return {
    handle(name: string, fn: (payload: unknown) => Promise<unknown>): () => void {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    async request<T>(name: string, payload: unknown): Promise<T> {
      const fn = handlers.get(name);
      if (!fn) throw new Error(`no handler for ${name}`);
      return (await fn(payload)) as T;
    },
  };
}

const MEMORY_ITEM = { id: '7', title: 'gotcha', content: 'workers drop module globals', importance: 0.8 };

describe('worker memory bridge (shims ↔ handlers)', () => {
  it('round-trips retrieve / extract / isConfigured through the bridge', async () => {
    const bridge = makeFakeBridge();
    const retrieve = vi.fn().mockResolvedValue([MEMORY_ITEM]);
    const extractAndPersist = vi.fn().mockResolvedValue(undefined);
    const memoryQuerySynthesizer = vi.fn().mockResolvedValue('oauth refresh flow');
    const deps: WorkerMemoryDeps = {
      memoryRetriever: { retrieve } as unknown as WorkerMemoryDeps['memoryRetriever'],
      memoryQuerySynthesizer,
      runEndMemory: {
        extractAndPersist,
        isConfigured: vi.fn().mockResolvedValue(true),
      } as unknown as WorkerMemoryDeps['runEndMemory'],
    };
    registerWorkerMemoryHandlers(bridge, () => deps);
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    await expect(shims.memoryRetriever.retrieve(1, 'proj', 'fix the auth bug')).resolves.toEqual([MEMORY_ITEM]);
    expect(retrieve).toHaveBeenCalledWith(1, 'proj', 'fix the auth bug');

    const tail = [{ role: 'user' as const, text: 'continue' }];
    await expect(shims.memoryQuerySynthesizer(tail)).resolves.toBe('oauth refresh flow');
    expect(memoryQuerySynthesizer).toHaveBeenCalledWith(tail);

    await shims.runEndMemory.extractAndPersist(1, 'proj', { summary: 's', succeeded: true });
    expect(extractAndPersist).toHaveBeenCalledWith(1, 'proj', { summary: 's', succeeded: true });

    await expect(shims.runEndMemory.isConfigured()).resolves.toBe(true);
  });

  it('degrades to no-op when the deps box is empty', async () => {
    const bridge = makeFakeBridge();
    registerWorkerMemoryHandlers(bridge, () => undefined);
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    await expect(shims.memoryRetriever.retrieve(1, 'proj', 'long enough query')).resolves.toEqual([]);
    await expect(shims.memoryQuerySynthesizer([{ role: 'user', text: 'continue' }])).resolves.toBeNull();
    await expect(shims.runEndMemory.extractAndPersist(1, 'proj', {})).resolves.toBeUndefined();
    await expect(shims.runEndMemory.isConfigured()).resolves.toBe(false);
  });

  it('degrades to no-op when no handler is registered at all (headless)', async () => {
    const bridge = makeFakeBridge(); // nothing registered → request throws
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    await expect(shims.memoryRetriever.retrieve(1, 'proj', 'long enough query')).resolves.toEqual([]);
    await expect(shims.memoryQuerySynthesizer([{ role: 'user', text: 'continue' }])).resolves.toBeNull();
    await expect(shims.runEndMemory.extractAndPersist(1, 'proj', {})).resolves.toBeUndefined();
    await expect(shims.runEndMemory.isConfigured()).resolves.toBe(false);
  });

  it('caches isConfigured so repeated runs pay one RPC per window', async () => {
    const bridge = makeFakeBridge();
    const isConfigured = vi.fn().mockResolvedValue(true);
    registerWorkerMemoryHandlers(bridge, () => ({
      runEndMemory: { extractAndPersist: vi.fn(), isConfigured } as unknown as WorkerMemoryDeps['runEndMemory'],
    }));
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    await shims.runEndMemory.isConfigured();
    await shims.runEndMemory.isConfigured();
    await shims.runEndMemory.isConfigured();
    expect(isConfigured).toHaveBeenCalledTimes(1);
  });

  it('disposer detaches every handler', async () => {
    const bridge = makeFakeBridge();
    const off = registerWorkerMemoryHandlers(bridge, () => undefined);
    off();
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);
    // Handlers gone → request throws inside the shim → degrade, not crash.
    await expect(shims.memoryRetriever.retrieve(1, 'proj', 'long enough query')).resolves.toEqual([]);
  });
});
