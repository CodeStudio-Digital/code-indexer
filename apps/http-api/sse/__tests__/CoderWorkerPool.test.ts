import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoderRunBus } from '../../coder-bus.js';
import type {
  ControlPlaneRunContext,
  ControlPlaneStore,
} from '@mcp/store/control-plane/index.js';

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

  function createPool(controlPlaneStore: ControlPlaneStore | null = null): CoderWorkerPool {
    pool = new CoderWorkerPool({
      workerFile: 'mock-worker.js',
      dbPath: ':memory:',
      postRunLingerMs: 60_000,
      log: () => undefined,
      getControlPlaneStore: () => controlPlaneStore,
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

  it('fences a rejected control-plane attempt without replacing the active run context', async () => {
    const storeSpies = {
      terminalizeRun: vi.fn(),
      interruptRun: vi.fn(),
    };
    const activeContext = {
      sessionId: 'session:coder:14',
      legacySessionId: 14,
      commandId: 'command:coder:14:active',
      correlationId: 'correlation:coder:14:active',
      actor: { actorId: 'local-user', actorType: 'user', source: 'http' },
      agentRunId: 'agent-run:coder:14:active',
      attemptId: 'agent-run-attempt:coder:14:active:1',
      executorOwnerId: 'coder-worker:14:active',
      fencingEpoch: 1,
    } as unknown as ControlPlaneRunContext;
    const rejectedContext = {
      ...activeContext,
      commandId: 'command:coder:14:rejected',
      correlationId: 'correlation:coder:14:rejected',
      agentRunId: 'agent-run:coder:14:rejected',
      attemptId: 'agent-run-attempt:coder:14:rejected:1',
      executorOwnerId: 'coder-worker:14:rejected',
    } as unknown as ControlPlaneRunContext;
    const p = createPool(storeSpies as unknown as ControlPlaneStore);
    await p.runFresh(14, { userMessage: 'first', controlPlaneRunContext: activeContext });

    await expect(p.runFresh(14, {
      userMessage: 'second',
      controlPlaneRunContext: rejectedContext,
    })).rejects.toThrow('run already in progress');

    expect(storeSpies.interruptRun).toHaveBeenCalledWith(expect.objectContaining({
      context: rejectedContext,
      status: 'interrupted',
      commandStatus: 'failed',
      reason: 'run-already-in-progress',
      attemptLeaseStatus: 'fenced',
    }));
    expect(storeSpies.terminalizeRun).not.toHaveBeenCalled();
    expect(p.getControlPlaneRunContext(14)).toEqual(activeContext);
    expect(mockWorker.state.hosts[0].bridge.requests.filter((request) => request.type === 'runFresh')).toHaveLength(1);
  });

  it('fences the control-plane attempt when runFresh dispatch fails before ACK', async () => {
    const storeSpies = {
      terminalizeRun: vi.fn(),
      interruptRun: vi.fn(),
    };
    const context = {
      sessionId: 'session:coder:9',
      legacySessionId: 9,
      commandId: 'command:coder:9',
      correlationId: 'correlation:coder:9',
      actor: { actorId: 'local-user', actorType: 'user', source: 'http' },
      agentRunId: 'agent-run:coder:9',
      attemptId: 'agent-run-attempt:coder:9:1',
      executorOwnerId: 'coder-worker:9',
      fencingEpoch: 1,
    } as unknown as ControlPlaneRunContext;
    const p = createPool(storeSpies as unknown as ControlPlaneStore);
    mockWorker.state.requestImpl = async () => {
      throw new Error('run setup failed');
    };

    await expect(p.runFresh(9, {
      userMessage: 'first',
      controlPlaneRunContext: context,
    })).rejects.toThrow('run setup failed');

    expect(storeSpies.interruptRun).toHaveBeenCalledWith(expect.objectContaining({
      context,
      status: 'interrupted',
      commandStatus: 'failed',
      reason: 'worker-runFresh-failed',
      attemptLeaseStatus: 'fenced',
    }));
    expect(storeSpies.terminalizeRun).not.toHaveBeenCalled();
    expect(p.getControlPlaneRunContext(9)).toBeNull();
  });

  it('mirrors lifecycle boundaries while keeping the control-plane context host-only', async () => {
    const previousControlPlane = process.env.CODER_CONTROL_PLANE_SHADOW;
    const previousJournal = process.env.CODER_RUNTIME_JOURNAL_SHADOW;
    process.env.CODER_CONTROL_PLANE_SHADOW = '1';
    process.env.CODER_RUNTIME_JOURNAL_SHADOW = '1';
    try {
      const storeSpies = {
        markRunStarted: vi.fn(),
        appendToolBoundary: vi.fn(),
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
        runs: { renewAttemptLease: vi.fn() },
      };
      const context = {
        sessionId: 'session:coder:13',
        legacySessionId: 13,
        commandId: 'command:coder:13',
        correlationId: 'correlation:coder:13',
        actor: { actorId: 'local-user', actorType: 'user', source: 'http' },
        agentRunId: 'agent-run:coder:13',
        attemptId: 'agent-run-attempt:coder:13:1',
        executorOwnerId: 'coder-worker:13',
        fencingEpoch: 1,
      } as unknown as ControlPlaneRunContext;
      const p = createPool(storeSpies as unknown as ControlPlaneStore);
      const bus = await p.runFresh(13, {
        userMessage: 'first',
        controlPlaneRunContext: context,
      });
      const host = mockWorker.state.hosts[0];
      const runId = getRunId(bus);
      const runRequest = host.bridge.requests.at(-1);

      expect(runRequest?.payload).not.toHaveProperty('controlPlaneRunContext');
      expect(p.getControlPlaneRunContext(13)).toEqual(context);

      host.bridge.emitToPool('bus.event', {
        runId,
        event: 'run_started',
        data: { runId: 'runner-native-13' },
      });
      host.bridge.emitToPool('bus.event', {
        runId,
        event: 'tool_call_start',
        data: { id: 'tool-1', name: 'edit_file', input: { secret: 'never-persist-raw' } },
      });
      host.bridge.emitToPool('bus.event', {
        runId,
        event: 'tool_call_result',
        data: { id: 'tool-1', name: 'edit_file', result: 'sensitive-result', duration_ms: 12 },
      });
      host.bridge.emitToPool('bus.end', {
        runId,
        event: 'done',
        data: { reason: 'completed' },
      });

      expect(storeSpies.markRunStarted).toHaveBeenCalledWith(context, 'runner-native-13');
      expect(storeSpies.appendToolBoundary).toHaveBeenCalledTimes(2);
      expect(storeSpies.appendToolBoundary).toHaveBeenNthCalledWith(1, expect.objectContaining({
        context,
        phase: 'started',
        toolUseId: 'tool-1',
        toolName: 'edit_file',
        payload: { valueHash: expect.stringMatching(/^[a-f0-9]{64}$/), durationMs: null },
      }));
      expect(JSON.stringify(storeSpies.appendToolBoundary.mock.calls)).not.toContain('never-persist-raw');
      expect(JSON.stringify(storeSpies.appendToolBoundary.mock.calls)).not.toContain('sensitive-result');
      expect(storeSpies.terminalizeRun).toHaveBeenCalledWith(expect.objectContaining({
        context,
        status: 'completed',
        commandStatus: 'succeeded',
        reason: 'completed',
      }));
      expect(p.getControlPlaneRunContext(13)).toBeNull();
    } finally {
      if (previousControlPlane === undefined) delete process.env.CODER_CONTROL_PLANE_SHADOW;
      else process.env.CODER_CONTROL_PLANE_SHADOW = previousControlPlane;
      if (previousJournal === undefined) delete process.env.CODER_RUNTIME_JOURNAL_SHADOW;
      else process.env.CODER_RUNTIME_JOURNAL_SHADOW = previousJournal;
    }
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
