import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoderRunBus } from '../../coder-bus.js';

const mockWorker = vi.hoisted(() => {
  type Listener = (payload: unknown) => void;
  type RequestImpl = (
    type: string,
    payload: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<unknown>;

  class MockBridge {
    requests: Array<{ type: string; payload: unknown; opts?: { timeoutMs?: number } }> = [];
    listeners = new Map<string, Set<Listener>>();

    async request(type: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
      this.requests.push({ type, payload, opts });
      if (state.requestImpl) return state.requestImpl(type, payload, opts);
      return { ok: true };
    }

    handle(): () => void {
      return () => undefined;
    }

    on(type: string, listener: Listener): () => void {
      const set = this.listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(type, set);
      return () => set.delete(listener);
    }

    emitToPool(type: string, payload: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(payload);
      }
    }
  }

  class MockWorkerHost {
    state = 'running';
    bridge = new MockBridge();
    startCalls = 0;
    evictCalls = 0;

    constructor(readonly opts: unknown) {
      state.hosts.push(this);
    }

    async start(): Promise<void> {
      this.startCalls += 1;
      this.state = 'running';
    }

    requireBridge(): MockBridge {
      return this.bridge;
    }

    async evict(): Promise<void> {
      this.evictCalls += 1;
      this.state = 'idle';
    }
  }

  const state: {
    hosts: MockWorkerHost[];
    requestImpl: RequestImpl | null;
  } = {
    hosts: [],
    requestImpl: null,
  };

  return { MockWorkerHost, state };
});

vi.mock('@mcp/orchestrator-host', () => ({
  WorkerHost: mockWorker.MockWorkerHost,
}));

import { CoderWorkerPool } from '../CoderWorkerPool.js';

function getRunId(bus: CoderRunBus): number {
  const host = mockWorker.state.hosts[0];
  const request = host.bridge.requests.at(-1);
  expect(request?.type).toBe('runFresh');
  const payload = request?.payload as { runId?: number };
  expect(typeof payload.runId).toBe('number');
  expect(bus.ended).toBe(false);
  return payload.runId as number;
}

describe('CoderWorkerPool', () => {
  let pool: CoderWorkerPool | null = null;

  beforeEach(() => {
    mockWorker.state.hosts.length = 0;
    mockWorker.state.requestImpl = null;
  });

  afterEach(async () => {
    await pool?.dispose();
    pool = null;
  });

  function createPool(): CoderWorkerPool {
    pool = new CoderWorkerPool({
      workerFile: 'mock-worker.js',
      dbPath: ':memory:',
      postRunLingerMs: 60_000,
      log: () => undefined,
    });
    return pool;
  }

  it('reuses the same worker but creates a fresh mirrored bus after run end', async () => {
    const p = createPool();

    const bus1 = await p.runFresh(7, { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];
    const runId1 = getRunId(bus1);

    host.bridge.emitToPool('bus.event', {
      runId: runId1,
      event: 'text',
      data: { text: 'hello' },
    });
    host.bridge.emitToPool('bus.end', {
      runId: runId1,
      event: 'done',
      data: { reason: 'completed' },
    });

    expect(bus1.ended).toBe(true);
    expect(bus1.buffer.some((ev) => ev.event === 'text')).toBe(true);

    const bus2 = await p.runFresh(7, { userMessage: 'second' });
    const runId2 = getRunId(bus2);

    expect(bus2).not.toBe(bus1);
    expect(runId2).not.toBe(runId1);
    expect(host.startCalls).toBe(1);
    expect(host.evictCalls).toBe(0);
    expect(mockWorker.state.hosts).toHaveLength(1);
  });

  it('bounds each coder isolate to the memory-safe default heap ceiling', async () => {
    const p = createPool();
    await p.runFresh(70, { userMessage: 'first' });

    const opts = mockWorker.state.hosts[0].opts as {
      resourceLimits?: { maxOldGenerationSizeMb?: number };
    };
    expect(opts.resourceLimits?.maxOldGenerationSizeMb).toBe(1_024);
  });

  it('ignores late events and terminal signals from an old runId', async () => {
    const p = createPool();

    const bus1 = await p.runFresh(8, { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];
    const runId1 = getRunId(bus1);
    host.bridge.emitToPool('bus.end', {
      runId: runId1,
      event: 'done',
      data: { reason: 'completed' },
    });

    const bus2 = await p.runFresh(8, { userMessage: 'second' });
    const runId2 = getRunId(bus2);

    host.bridge.emitToPool('bus.event', {
      runId: runId1,
      event: 'text',
      data: { text: 'stale' },
    });
    host.bridge.emitToPool('bus.end', {
      runId: runId1,
      event: 'done',
      data: { reason: 'stale' },
    });

    expect(bus2.buffer.some((ev) => ev.event === 'text')).toBe(false);
    expect(bus2.ended).toBe(false);

    host.bridge.emitToPool('bus.event', {
      runId: runId2,
      event: 'text',
      data: { text: 'current' },
    });

    expect(bus2.buffer.some((ev) => ev.event === 'text')).toBe(true);
  });

  it('resets in-progress state when runFresh RPC fails', async () => {
    const p = createPool();
    mockWorker.state.requestImpl = async () => {
      throw new Error('run setup failed');
    };

    await expect(p.runFresh(9, { userMessage: 'first' })).rejects.toThrow('run setup failed');
    const failedBus = p.getBus(9);
    expect(failedBus?.ended).toBe(true);

    mockWorker.state.requestImpl = null;
    const bus2 = await p.runFresh(9, { userMessage: 'second' });

    expect(bus2).not.toBe(failedBus);
    expect(bus2.ended).toBe(false);
    expect(mockWorker.state.hosts[0].bridge.requests.filter((request) => request.type === 'runFresh')).toHaveLength(2);
  });

  it('forwards the persisted round message id to an active worker follow-up', async () => {
    const p = createPool();
    await p.runFresh(10, { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];

    await p.pushUserMessage(10, 'follow-up', ['skill-a'], 42);

    expect(host.bridge.requests.at(-1)).toMatchObject({
      type: 'pushUserMessage',
      payload: {
        content: 'follow-up',
        selectedSkillIds: ['skill-a'],
        roundMessageId: 42,
      },
    });
  });

  it('updates active workers only after ACK and preserves failed worker state', async () => {
    const previous = process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS;
    process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS = '0';
    try {
      const p = createPool();
      await p.runFresh(11, { userMessage: 'first' });
      expect(p.qualitySnapshot()).toEqual([{ sessionId: 11, enabled: false }]);

      mockWorker.state.requestImpl = async (type) => {
        if (type === 'quality.setEnabled') return { enabled: true };
        return { ok: true };
      };
      await expect(p.setQualityEnabled(true)).resolves.toEqual({ total: 1, acknowledged: 1, failed: 0 });
      expect(p.qualitySnapshot()).toEqual([{ sessionId: 11, enabled: true }]);

      mockWorker.state.requestImpl = async (type) => {
        if (type === 'quality.setEnabled') throw new Error('ACK timeout');
        return { ok: true };
      };
      await expect(p.setQualityEnabled(false)).resolves.toEqual({ total: 1, acknowledged: 0, failed: 1 });
      expect(p.qualitySnapshot()).toEqual([{ sessionId: 11, enabled: true }]);
    } finally {
      if (previous === undefined) delete process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS;
      else process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS = previous;
    }
  });

  it('confirms the current Quality toggle on newly spawned workers', async () => {
    const previous = process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS;
    process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS = '1';
    try {
      mockWorker.state.requestImpl = async (type) => type === 'quality.status'
        ? { enabled: true }
        : { ok: true };
      const p = createPool();
      await p.runFresh(12, { userMessage: 'first' });
      expect(mockWorker.state.hosts[0].bridge.requests.some((request) => request.type === 'quality.status')).toBe(true);
      expect(p.qualitySnapshot()).toEqual([{ sessionId: 12, enabled: true }]);
    } finally {
      if (previous === undefined) delete process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS;
      else process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS = previous;
    }
  });
});
