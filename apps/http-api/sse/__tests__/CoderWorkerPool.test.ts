import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { CoderRunBus } from '../../coder-bus.js';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asSessionCommandId,
  asSessionId,
} from '@mcp/agent-runtime-contracts';
import { controlPlaneFoundation251 } from '@mcp/store/migrations/251_control_plane_foundation.js';
import { controlPlaneAlignment252 } from '@mcp/store/migrations/252_control_plane_alignment.js';
import {
  ControlPlaneDivergenceStore,
  ControlPlaneStore,
  hashControlPlanePayload,
  type ControlPlaneRunContext,
} from '@mcp/store/control-plane/index.js';
import {
  coderControlPlaneShadowEnabled,
  drainLocalCoderShadowWrites,
  resetCoderControlPlaneShadowMetricsForTests,
  snapshotCoderControlPlaneShadowMetrics,
} from '../../control-plane-shadow.js';

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

import {
  CoderWorkerPool,
  CONTROL_PLANE_LEASE_RENEW_INTERVAL_MS,
} from '../CoderWorkerPool.js';

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
    await drainLocalCoderShadowWrites();
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

  function makeRunContext(sessionId: number, tag: string): ControlPlaneRunContext {
    return {
      sessionId: `session:coder:${sessionId}`,
      legacySessionId: sessionId,
      commandId: `command:coder:${sessionId}:${tag}`,
      correlationId: `correlation:coder:${sessionId}:${tag}`,
      actor: { actorId: 'local-user', actorType: 'user', source: 'http' },
      agentRunId: `agent-run:coder:${sessionId}:${tag}`,
      attemptId: `agent-run-attempt:coder:${sessionId}:${tag}:1`,
      executorOwnerId: `coder-worker:${sessionId}:${tag}`,
      fencingEpoch: 1,
    } as unknown as ControlPlaneRunContext;
  }

  it('enables the root projection when child AgentRun shadow or enforcement is selected', () => {
    const previousRoot = process.env.CODER_CONTROL_PLANE_SHADOW;
    const previousChild = process.env.CODER_AGENT_RUN_STORE_SHADOW;
    const previousEnforce = process.env.CODER_AGENT_RUN_STORE_ENFORCE;
    try {
      delete process.env.CODER_CONTROL_PLANE_SHADOW;
      delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
      delete process.env.CODER_AGENT_RUN_STORE_ENFORCE;
      expect(coderControlPlaneShadowEnabled()).toBe(false);

      process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';
      expect(coderControlPlaneShadowEnabled()).toBe(true);

      delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
      process.env.CODER_AGENT_RUN_STORE_ENFORCE = '1';
      expect(coderControlPlaneShadowEnabled()).toBe(true);
    } finally {
      if (previousRoot === undefined) delete process.env.CODER_CONTROL_PLANE_SHADOW;
      else process.env.CODER_CONTROL_PLANE_SHADOW = previousRoot;
      if (previousChild === undefined) delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
      else process.env.CODER_AGENT_RUN_STORE_SHADOW = previousChild;
      if (previousEnforce === undefined) delete process.env.CODER_AGENT_RUN_STORE_ENFORCE;
      else process.env.CODER_AGENT_RUN_STORE_ENFORCE = previousEnforce;
    }
  });

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

  it('normalizes a mixed-version done failure before the bus and ledger observe it', async () => {
    const terminalizeRun = vi.fn();
    const storeSpies = {
      terminalizeRun,
      interruptRun: vi.fn(),
      runs: { renewAttemptLease: vi.fn() },
    };
    const context = makeRunContext(71, 'failure-terminal');
    const p = createPool(storeSpies as unknown as ControlPlaneStore);
    const bus = await p.runFresh(71, {
      userMessage: 'fail after persistence',
      controlPlaneRunContext: context,
    });
    const host = mockWorker.state.hosts[0];
    const runId = getRunId(bus);

    const legacyTerminal = {
      runId,
      event: 'done',
      data: { reason: 'recovery_capped', error: 'provider recovery exhausted' },
    } as const;
    host.bridge.emitToPool('bus.event', legacyTerminal);
    host.bridge.emitToPool('bus.end', legacyTerminal);

    expect(bus.endReason).toEqual({
      event: 'error',
      data: {
        reason: 'recovery_capped',
        error: 'provider recovery exhausted',
        message: 'provider recovery exhausted',
      },
    });
    expect(bus.buffer.at(-1)).toMatchObject({
      event: 'error',
      data: {
        reason: 'recovery_capped',
        message: 'provider recovery exhausted',
      },
    });
    expect(terminalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      context,
      status: 'failed',
      commandStatus: 'failed',
      reason: 'recovery_capped',
    }));
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

  it('renews a silent active run for eleven minutes without depending on bus events', async () => {
    vi.useFakeTimers();
    try {
      const renewAttemptLease = vi.fn();
      const storeSpies = {
        runs: { renewAttemptLease },
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
      };
      const context = makeRunContext(18, 'silent');
      const p = createPool(storeSpies as unknown as ControlPlaneStore);
      const bus = await p.runFresh(18, {
        userMessage: 'long silent provider call',
        controlPlaneRunContext: context,
      });

      await vi.advanceTimersByTimeAsync(11 * 60_000);

      expect(bus.ended).toBe(false);
      expect(p.getControlPlaneRunContext(18)).toEqual(context);
      expect(renewAttemptLease).toHaveBeenCalledTimes(11);
      expect(renewAttemptLease.mock.calls.every((call) => call[0] === context)).toBe(true);
      const lastRenewal = renewAttemptLease.mock.calls.at(-1);
      expect(Date.parse(lastRenewal?.[1] as string) - Date.parse(lastRenewal?.[2] as string))
        .toBe(10 * 60_000);
    } finally {
      await pool?.dispose();
      pool = null;
      vi.useRealTimers();
    }
  });

  it('does not let an evicted entry renew the replacement run authority', async () => {
    vi.useFakeTimers();
    try {
      const renewAttemptLease = vi.fn();
      const storeSpies = {
        runs: { renewAttemptLease },
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
      };
      const oldContext = makeRunContext(19, 'old');
      const replacementContext = {
        ...makeRunContext(19, 'replacement'),
        fencingEpoch: 2,
      } as ControlPlaneRunContext;
      const p = createPool(storeSpies as unknown as ControlPlaneStore);

      await p.runFresh(19, { userMessage: 'old', controlPlaneRunContext: oldContext });
      await p.evict(19);
      await p.runFresh(19, {
        userMessage: 'replacement',
        controlPlaneRunContext: replacementContext,
      });
      renewAttemptLease.mockClear();

      await vi.advanceTimersByTimeAsync(CONTROL_PLANE_LEASE_RENEW_INTERVAL_MS);

      expect(mockWorker.state.hosts).toHaveLength(2);
      expect(renewAttemptLease).toHaveBeenCalledTimes(1);
      expect(renewAttemptLease).toHaveBeenCalledWith(
        replacementContext,
        expect.any(String),
        expect.any(String),
      );
      expect(renewAttemptLease).not.toHaveBeenCalledWith(
        oldContext,
        expect.any(String),
        expect.any(String),
      );
    } finally {
      await pool?.dispose();
      pool = null;
      vi.useRealTimers();
    }
  });

  it('fences and aborts the executor when lease renewal loses authority', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const storeSpies = {
        runs: {
          renewAttemptLease: vi.fn(() => {
            throw new Error('attempt was fenced');
          }),
        },
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
      };
      const context = makeRunContext(20, 'authority-loss');
      const p = createPool(storeSpies as unknown as ControlPlaneStore);
      const bus = await p.runFresh(20, {
        userMessage: 'must stop on lost authority',
        controlPlaneRunContext: context,
      });
      const host = mockWorker.state.hosts[0];
      const runId = getRunId(bus);

      await vi.advanceTimersByTimeAsync(CONTROL_PLANE_LEASE_RENEW_INTERVAL_MS);

      expect(bus.ended).toBe(true);
      expect(bus.endReason).toEqual({
        event: 'error',
        data: expect.objectContaining({
          reason: 'control-plane-authority-lost',
          authorityLost: true,
          runId,
        }),
      });
      expect(storeSpies.interruptRun).toHaveBeenCalledWith(expect.objectContaining({
        context,
        status: 'interrupted',
        commandStatus: 'failed',
        reason: 'control-plane-authority-lost',
        attemptLeaseStatus: 'fenced',
      }));
      expect(host.bridge.requests).toContainEqual(expect.objectContaining({
        type: 'abort',
        payload: { reason: 'control-plane-authority-lost' },
      }));
      expect(host.evictCalls).toBe(1);
      expect(p.has(20)).toBe(false);

      // Even if a terminal from the fenced worker was already queued, its
      // detached listener/context cannot rewrite authority as success.
      host.bridge.emitToPool('bus.end', {
        runId,
        event: 'done',
        data: { reason: 'completed' },
      });
      expect(storeSpies.terminalizeRun).not.toHaveBeenCalled();
      expect(storeSpies.interruptRun).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      await pool?.dispose();
      pool = null;
      vi.useRealTimers();
    }
  });

  it('fences a rejected control-plane attempt without replacing the active run context', async () => {
    const previousControlPlane = process.env.CODER_CONTROL_PLANE_SHADOW;
    process.env.CODER_CONTROL_PLANE_SHADOW = '1';
    try {
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
    } finally {
      if (previousControlPlane === undefined) delete process.env.CODER_CONTROL_PLANE_SHADOW;
      else process.env.CODER_CONTROL_PLANE_SHADOW = previousControlPlane;
    }
  });

  it('fences the control-plane attempt when runFresh dispatch fails before ACK', async () => {
    const previousControlPlane = process.env.CODER_CONTROL_PLANE_SHADOW;
    process.env.CODER_CONTROL_PLANE_SHADOW = '1';
    try {
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
    } finally {
      if (previousControlPlane === undefined) delete process.env.CODER_CONTROL_PLANE_SHADOW;
      else process.env.CODER_CONTROL_PLANE_SHADOW = previousControlPlane;
    }
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
      expect(runRequest?.payload).toMatchObject({
        controlPlaneParentAgentRunId: context.agentRunId,
      });
      expect(runRequest?.payload).not.toHaveProperty('attemptId');
      expect(runRequest?.payload).not.toHaveProperty('executorOwnerId');
      expect(runRequest?.payload).not.toHaveProperty('fencingEpoch');
      expect(runRequest?.payload).not.toHaveProperty('actor');
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
      await drainLocalCoderShadowWrites();

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

  it('mirrors the extended A–C runner vocabulary with redacted payloads', async () => {
    const previousControlPlane = process.env.CODER_CONTROL_PLANE_SHADOW;
    const previousJournal = process.env.CODER_RUNTIME_JOURNAL_SHADOW;
    process.env.CODER_CONTROL_PLANE_SHADOW = '1';
    process.env.CODER_RUNTIME_JOURNAL_SHADOW = '1';
    try {
      const journalAppend = vi.fn();
      const storeSpies = {
        markRunStarted: vi.fn(),
        appendToolBoundary: vi.fn(),
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
        runs: { renewAttemptLease: vi.fn() },
        journal: { append: journalAppend },
      };
      const context = {
        sessionId: 'session:coder:15',
        legacySessionId: 15,
        commandId: 'command:coder:15',
        correlationId: 'correlation:coder:15',
        actor: { actorId: 'local-user', actorType: 'user', source: 'http' },
        agentRunId: 'agent-run:coder:15',
        attemptId: 'agent-run-attempt:coder:15:1',
        executorOwnerId: 'coder-worker:15',
        fencingEpoch: 1,
      } as unknown as ControlPlaneRunContext;
      const p = createPool(storeSpies as unknown as ControlPlaneStore);
      const bus = await p.runFresh(15, { userMessage: 'first', controlPlaneRunContext: context });
      const host = mockWorker.state.hosts[0];
      const runId = getRunId(bus);
      const emit = (event: string, data: unknown) => host.bridge.emitToPool('bus.event', { runId, event, data });

      emit('tool_approval_request', { toolUseId: 'tu-1', toolName: 'edit_file', argsSummary: 'SECRET-ARGS', riskClass: 'write', approvalKind: 'standard', turn: 3 });
      emit('tool_approval_resolved', { toolUseId: 'tu-1', toolName: 'edit_file', approved: true, source: 'user', note: 'SECRET-NOTE' });
      emit('awaiting_input', { askId: 'ask-1' });
      emit('provider_swapped', { provider: 'kimi', model: 'k2' });
      emit('fallback_activated', { from: { provider: 'a', model: 'm1' }, to: { provider: 'b', model: 'm2' }, error: 'SECRET-PROVIDER-ERROR' });
      emit('history_compacted', { strategy: 'summarizer', pruned_messages: 4, pruned_chars: 1000, total_chars_before: 5000, total_chars_after: 4000, auto_continue: 1 });
      emit('workflow_run_started', { workflow_id: 'wf-1', name: 'demo', total_waves: 2, steps: [{ id: 's1' }, { id: 's2' }] });
      emit('workflow_run_finished', { workflow_id: 'wf-1', status: 'completed', completed_count: 2, failed_count: 0, skipped_count: 0 });
      emit('agents_group_start', { groupId: 'g-1', agents: [{ index: 0 }, { index: 1 }], provider: 'a', model: 'm' });
      emit('agents_group_end', { groupId: 'g-1', agentCount: 2, successCount: 2, completedCount: 2, partialCount: 0, failedCount: 0, resumableCount: 0 });
      emit('worktree_entered', { path: 'SECRET-PATH', originalCwd: 'SECRET-CWD' });
      emit('worktree_exited', { path: 'SECRET-PATH' });
      await drainLocalCoderShadowWrites();

      expect(journalAppend).toHaveBeenCalledTimes(12);
      const types = journalAppend.mock.calls.map((call) => (call[0] as { type: string }).type);
      expect(types).toEqual([
        'tool.approval.requested', 'tool.approval.resolved', 'interaction.requested',
        'provider.swapped', 'provider.fallback', 'history.compacted',
        'workflow.run.started', 'workflow.run.finished',
        'agents.group.started', 'agents.group.finished',
        'worktree.entered', 'worktree.exited',
      ]);
      const serialized = JSON.stringify(journalAppend.mock.calls);
      expect(serialized).not.toContain('SECRET-ARGS');
      expect(serialized).not.toContain('SECRET-NOTE');
      expect(serialized).not.toContain('SECRET-PROVIDER-ERROR');
      expect(serialized).not.toContain('SECRET-PATH');
      expect(serialized).not.toContain('SECRET-CWD');
      const classes = Object.fromEntries(
        journalAppend.mock.calls.map((call) => {
          const input = call[0] as { type: string; eventClass: string };
          return [input.type, input.eventClass];
        }),
      );
      expect(classes['tool.approval.resolved']).toBe('A');
      expect(classes['provider.swapped']).toBe('C');
    } finally {
      if (previousControlPlane === undefined) delete process.env.CODER_CONTROL_PLANE_SHADOW;
      else process.env.CODER_CONTROL_PLANE_SHADOW = previousControlPlane;
      if (previousJournal === undefined) delete process.env.CODER_RUNTIME_JOURNAL_SHADOW;
      else process.env.CODER_RUNTIME_JOURNAL_SHADOW = previousJournal;
    }
  });

  it('keeps accepted run authority terminalizable when observational flags flip off', async () => {
    const previousControlPlane = process.env.CODER_CONTROL_PLANE_SHADOW;
    const previousJournal = process.env.CODER_RUNTIME_JOURNAL_SHADOW;
    process.env.CODER_CONTROL_PLANE_SHADOW = '1';
    process.env.CODER_RUNTIME_JOURNAL_SHADOW = '1';
    try {
      const journalAppend = vi.fn();
      const storeSpies = {
        markRunStarted: vi.fn(),
        appendToolBoundary: vi.fn(),
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
        runs: { renewAttemptLease: vi.fn() },
        journal: { append: journalAppend },
      };
      const context = {
        sessionId: 'session:coder:16',
        legacySessionId: 16,
        commandId: 'command:coder:16',
        correlationId: 'correlation:coder:16',
        actor: { actorId: 'local-user', actorType: 'user', source: 'http' },
        agentRunId: 'agent-run:coder:16',
        attemptId: 'agent-run-attempt:coder:16:1',
        executorOwnerId: 'coder-worker:16',
        fencingEpoch: 1,
      } as unknown as ControlPlaneRunContext;
      const p = createPool(storeSpies as unknown as ControlPlaneStore);
      const bus = await p.runFresh(16, { userMessage: 'first', controlPlaneRunContext: context });
      const host = mockWorker.state.hosts[0];
      const runId = getRunId(bus);

      process.env.CODER_CONTROL_PLANE_SHADOW = '0';

      host.bridge.emitToPool('bus.event', { runId, event: 'run_started', data: { runId: 'runner-16' } });
      host.bridge.emitToPool('bus.event', { runId, event: 'tool_call_start', data: { id: 't-1', name: 'edit_file', input: {} } });
      host.bridge.emitToPool('bus.event', { runId, event: 'provider_swapped', data: { provider: 'k', model: 'm' } });
      host.bridge.emitToPool('bus.end', { runId, event: 'done', data: { reason: 'completed' } });

      expect(storeSpies.markRunStarted).toHaveBeenCalledTimes(1);
      expect(storeSpies.appendToolBoundary).not.toHaveBeenCalled();
      expect(journalAppend).not.toHaveBeenCalled();
      expect(storeSpies.terminalizeRun).toHaveBeenCalledTimes(1);
    } finally {
      if (previousControlPlane === undefined) delete process.env.CODER_CONTROL_PLANE_SHADOW;
      else process.env.CODER_CONTROL_PLANE_SHADOW = previousControlPlane;
      if (previousJournal === undefined) delete process.env.CODER_RUNTIME_JOURNAL_SHADOW;
      else process.env.CODER_RUNTIME_JOURNAL_SHADOW = previousJournal;
    }
  });

  it('records comparator divergences when control-plane terminal state disagrees with the legacy signal', async () => {
    const previousControlPlane = process.env.CODER_CONTROL_PLANE_SHADOW;
    const previousJournal = process.env.CODER_RUNTIME_JOURNAL_SHADOW;
    process.env.CODER_CONTROL_PLANE_SHADOW = '1';
    process.env.CODER_RUNTIME_JOURNAL_SHADOW = '1';
    resetCoderControlPlaneShadowMetricsForTests();
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
      controlPlaneFoundation251.up(db);
      controlPlaneAlignment252.up(db);
      db.prepare('INSERT INTO coder_sessions(id) VALUES (?)').run(17);
      const store = new ControlPlaneStore(db, { journalEnabled: true });
      const divergenceStore = new ControlPlaneDivergenceStore(db);
      const payload = { content: 'diverge' };
      const actor = { actorId: 'local-user', actorType: 'user' as const, source: 'http' as const };
      const accepted = store.acceptCommand({
        command: {
          schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
          commandId: asSessionCommandId('command:diverge:1'),
          idempotencyKey: 'idem:diverge:1',
          kind: 'start',
          sessionId: asSessionId('session:coder:17'),
          actor,
          requestedAt: '2026-01-01T00:00:00.000Z',
          correlationId: asCorrelationId('correlation:diverge:1'),
          payload,
        },
        payloadHash: hashControlPlanePayload(payload),
        legacySessionId: 17,
        run: {
          agentRunId: asAgentRunId('agent-run:diverge:1'),
          attemptId: asAgentRunAttemptId('agent-run-attempt:diverge:1:1'),
          role: 'build',
          agentDefinitionId: 'build',
          waitMode: 'foreground',
          requestedCapabilityProfile: 'auto',
          executorOwnerId: 'coder-worker:17',
          executorExpiresAt: '2099-01-01T00:00:00.000Z',
        },
      });
      expect(accepted.kind).toBe('accepted');
      const runContext = {
        sessionId: asSessionId('session:coder:17'),
        legacySessionId: 17,
        commandId: asSessionCommandId('command:diverge:1'),
        correlationId: asCorrelationId('correlation:diverge:1'),
        actor,
        agentRunId: asAgentRunId('agent-run:diverge:1'),
        attemptId: asAgentRunAttemptId('agent-run-attempt:diverge:1:1'),
        executorOwnerId: 'coder-worker:17',
        fencingEpoch: 1,
      } as unknown as ControlPlaneRunContext;
      // Forge a disagreement: the control plane already terminalized the run
      // as interrupted/failed before the legacy bus reports a clean done.
      store.interruptRun({
        context: runContext,
        status: 'interrupted',
        commandStatus: 'failed',
        reason: 'worker-crashed',
      });

      pool = new CoderWorkerPool({
        workerFile: 'mock-worker.js',
        dbPath: ':memory:',
        postRunLingerMs: 60_000,
        log: () => undefined,
        getControlPlaneStore: () => store,
        getControlPlaneDivergenceStore: () => divergenceStore,
      });
      const bus = await pool.runFresh(17, { userMessage: 'first', controlPlaneRunContext: runContext });
      const host = mockWorker.state.hosts[0];
      const runId = getRunId(bus);
      host.bridge.emitToPool('bus.end', { runId, event: 'done', data: { reason: 'completed' } });

      await vi.waitFor(() => expect(divergenceStore.count()).toBe(2));
      expect(divergenceStore.list().map((row) => row.kind).sort()).toEqual([
        'command_status_mismatch',
        'run_status_mismatch',
      ]);
      expect(snapshotCoderControlPlaneShadowMetrics().divergences).toBe(2);
    } finally {
      db?.close();
      resetCoderControlPlaneShadowMetricsForTests();
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

});
