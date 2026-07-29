/**
 * Mem C worker bridge — main-side handlers + worker-side shims, exercised
 * against each other through a fake in-memory MessageBridge. Covers the
 * failure posture: missing deps / handler errors must degrade to no-op
 * (empty retrieval, skipped distillation, isConfigured=false) — memory can
 * never break a spawn or a run.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  clearMemorySaveOperationRegistryForTests,
  registerWorkerMemoryHandlers,
  type WorkerMemoryDeps,
} from '../worker-memory-handlers.js';
import { buildWorkerMemoryShims } from '../../workers/memory-shims.js';
import {
  ErrRequestTimeout,
  type MessageBridge,
} from '../../../../packages/orchestrator-host/src/index.js';
import { asSessionId } from '@mcp/session-storage';

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
const SESSION_ID = asSessionId('00000000-0000-4000-8000-000000000012');
const INVESTIGATION_ID = '00000000-0000-4000-8000-000000000009';
const OTHER_INVESTIGATION_ID = '00000000-0000-4000-8000-000000000004';

describe('worker memory bridge (shims ↔ handlers)', () => {
  it('reconciles a timed-out mutating RPC by operation id without replaying the save', async () => {
    vi.useFakeTimers();
    clearMemorySaveOperationRegistryForTests();
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    let firstSave = true;
    const bridge = {
      handle(name: string, fn: (payload: unknown) => Promise<unknown>): () => void {
        handlers.set(name, fn);
        return () => handlers.delete(name);
      },
      async request<T>(name: string, payload: unknown): Promise<T> {
        const fn = handlers.get(name);
        if (!fn) throw new Error(`no handler for ${name}`);
        if (name === 'memorySave' && firstSave) {
          firstSave = false;
          void fn(payload);
          throw new ErrRequestTimeout('simulated lost acknowledgement');
        }
        return (await fn(payload)) as T;
      },
    };
    const save = vi.fn().mockResolvedValue({ created: 1, merged: 0, skipped: 0 });
    registerWorkerMemoryHandlers(bridge, () => ({
      projectMemory: { save } as unknown as NonNullable<WorkerMemoryDeps['projectMemory']>,
    }));
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    const result = shims.projectMemory.save(7, 'p', {
      title: 'durable',
      content: 'write once',
      category: 'note',
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ created: 1, merged: 0, skipped: 0 });
    expect(save).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('reconciles a timed-out archive without replaying forget_memory', async () => {
    vi.useFakeTimers();
    clearMemorySaveOperationRegistryForTests();
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    let firstForget = true;
    const bridge = {
      handle(name: string, fn: (payload: unknown) => Promise<unknown>): () => void {
        handlers.set(name, fn);
        return () => handlers.delete(name);
      },
      async request<T>(name: string, payload: unknown): Promise<T> {
        const fn = handlers.get(name);
        if (!fn) throw new Error(`no handler for ${name}`);
        if (name === 'memoryForget' && firstForget) {
          firstForget = false;
          void fn(payload);
          throw new ErrRequestTimeout('simulated lost archive acknowledgement');
        }
        return (await fn(payload)) as T;
      },
    };
    const forget = vi.fn().mockResolvedValue({ archived: 1 });
    registerWorkerMemoryHandlers(bridge, () => ({
      projectMemory: { forget } as unknown as NonNullable<WorkerMemoryDeps['projectMemory']>,
    }));
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    const result = shims.projectMemory.forget(7, 'p', 'obsolete fact');
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ archived: 1 });
    expect(forget).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('surfaces unavailable persistence instead of returning a false success', async () => {
    clearMemorySaveOperationRegistryForTests();
    const bridge = makeFakeBridge();
    registerWorkerMemoryHandlers(bridge, () => ({
      projectMemory: {
        save: vi.fn().mockResolvedValue(null),
      } as unknown as NonNullable<WorkerMemoryDeps['projectMemory']>,
    }));
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    await expect(shims.projectMemory.save(7, 'p', {
      title: 'not saved',
      content: 'must fail',
      category: 'note',
    })).rejects.toMatchObject({ code: 'memory_unavailable' });
  });

  it('surfaces unavailable archive persistence instead of pretending the memory was absent', async () => {
    clearMemorySaveOperationRegistryForTests();
    const bridge = makeFakeBridge();
    registerWorkerMemoryHandlers(bridge, () => ({
      projectMemory: {
        save: vi.fn(),
      } as unknown as NonNullable<WorkerMemoryDeps['projectMemory']>,
    }));
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    await expect(shims.projectMemory.forget(7, 'p', 'obsolete fact'))
      .rejects.toMatchObject({ code: 'memory_unavailable' });
  });

  it('round-trips retrieve / extract / isConfigured through the bridge', async () => {
    const bridge = makeFakeBridge();
    const retrieve = vi.fn().mockResolvedValue([MEMORY_ITEM]);
    const extractAndPersist = vi.fn().mockResolvedValue(undefined);
    const memoryQuerySynthesizer = vi.fn().mockResolvedValue('oauth refresh flow');
    const investigationSearch = vi.fn().mockResolvedValue([
      INVESTIGATION_ID,
      OTHER_INVESTIGATION_ID,
    ]);
    const investigationWake = vi.fn();
    const deps: WorkerMemoryDeps = {
      memoryRetriever: { retrieve } as unknown as WorkerMemoryDeps['memoryRetriever'],
      memoryQuerySynthesizer,
      runEndMemory: {
        extractAndPersist,
        isConfigured: vi.fn().mockResolvedValue(true),
      } as unknown as WorkerMemoryDeps['runEndMemory'],
      investigationSemantic: {
        search: investigationSearch,
        wakeUpsert: investigationWake,
      },
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

    const searchInput = {
      sessionId: SESSION_ID,
      query: 'vector routing',
      limit: 8,
    };
    await expect(shims.investigationSemantic.search(searchInput)).resolves.toEqual([
      INVESTIGATION_ID,
      OTHER_INVESTIGATION_ID,
    ]);
    expect(investigationSearch).toHaveBeenCalledWith(searchInput);
    const record = {
      id: INVESTIGATION_ID,
      project_id: 1,
      session_id: SESSION_ID,
      topic: 't',
      summary: 's',
      body: '',
      source_label: null, agent_type: null, tokens: 0, created_at: '2026-07-15 10:00:00',
    };
    shims.investigationSemantic.wakeUpsert(record);
    await vi.waitFor(() => expect(investigationWake).toHaveBeenCalledWith(record));
  });

  it('degrades to no-op when the deps box is empty', async () => {
    const bridge = makeFakeBridge();
    registerWorkerMemoryHandlers(bridge, () => undefined);
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    await expect(shims.memoryRetriever.retrieve(1, 'proj', 'long enough query')).resolves.toEqual([]);
    await expect(shims.memoryQuerySynthesizer([{ role: 'user', text: 'continue' }])).resolves.toBeNull();
    await expect(shims.runEndMemory.extractAndPersist(1, 'proj', {})).resolves.toBeUndefined();
    await expect(shims.runEndMemory.isConfigured()).resolves.toBe(false);
    await expect(shims.investigationSemantic.search({ sessionId: SESSION_ID, query: 'q', limit: 8 }))
      .resolves.toEqual([]);
  });

  it('degrades to no-op when no handler is registered at all (headless)', async () => {
    const bridge = makeFakeBridge(); // nothing registered → request throws
    const shims = buildWorkerMemoryShims(bridge as unknown as MessageBridge);

    await expect(shims.memoryRetriever.retrieve(1, 'proj', 'long enough query')).resolves.toEqual([]);
    await expect(shims.memoryQuerySynthesizer([{ role: 'user', text: 'continue' }])).resolves.toBeNull();
    await expect(shims.runEndMemory.extractAndPersist(1, 'proj', {})).resolves.toBeUndefined();
    await expect(shims.runEndMemory.isConfigured()).resolves.toBe(false);
    await expect(shims.investigationSemantic.search({ sessionId: SESSION_ID, query: 'q', limit: 8 }))
      .resolves.toEqual([]);
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
