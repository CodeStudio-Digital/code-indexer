import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoderRunBus } from '../../coder-bus.js';
import {
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asSessionCommandId,
} from '@mcp/agent-runtime-contracts';
import {
  asSessionId,
  type SessionId,
} from '@mcp/session-storage';
import { resolveRuntimePolicyV1 } from '@mcp/agent-runtime-host';
import {
  type ControlPlaneRunContext,
} from '@mcp/store/control-plane/index.js';
import type { ControlPlaneAuthority } from '../../file-control-plane-store.js';
import {
  coderControlPlaneShadowEnabled,
  drainLocalCoderShadowWrites,
  resetCoderControlPlaneShadowMetricsForTests,
  snapshotCoderControlPlaneShadowMetrics,
} from '../../control-plane-shadow.js';
import {
  __flushRuntimeEventLogsForTests,
  __resetRuntimeEventLogsForTests,
} from '../runtime-event-log.js';

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
      if (type === 'releaseSessionWriter') {
        if (state.releaseWriterImpl) return state.releaseWriterImpl(type, payload, opts);
        return { ok: true };
      }
      if (type === 'acquireSessionWriter') {
        if (state.acquireWriterImpl) return state.acquireWriterImpl(type, payload, opts);
        return { ok: true };
      }
      if (state.requestImpl) return state.requestImpl(type, payload, opts);
      if (type === 'pushUserMessage') return { ok: true, roundMessageId: 42 };
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
      if (state.startImpl) await state.startImpl(this);
      this.state = 'running';
    }

    requireBridge(): MockBridge {
      return this.bridge;
    }

    async evict(): Promise<void> {
      this.evictCalls += 1;
      if (state.evictImpl) await state.evictImpl(this);
      this.state = 'idle';
    }
  }

  const state: {
    hosts: MockWorkerHost[];
    requestImpl: RequestImpl | null;
    acquireWriterImpl: RequestImpl | null;
    releaseWriterImpl: RequestImpl | null;
    startImpl: ((host: MockWorkerHost) => Promise<void>) | null;
    evictImpl: ((host: MockWorkerHost) => Promise<void>) | null;
  } = {
    hosts: [],
    requestImpl: null,
    acquireWriterImpl: null,
    releaseWriterImpl: null,
    startImpl: null,
    evictImpl: null,
  };

  return { MockWorkerHost, state };
});

vi.mock('@mcp/orchestrator-host', async importOriginal => ({
  ...await importOriginal<typeof import('@mcp/orchestrator-host')>(),
  WorkerHost: mockWorker.MockWorkerHost,
}));

import {
  CoderWorkerPool,
  CONTROL_PLANE_LEASE_RENEW_INTERVAL_MS,
  SESSION_WRITER_ACQUIRE_TIMEOUT_MS,
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

function sid(value: number): SessionId {
  return asSessionId(
    `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`,
  );
}

describe('CoderWorkerPool', () => {
  let pool: CoderWorkerPool | null = null;
  let bundleRoot: string;

  beforeEach(() => {
    mockWorker.state.hosts.length = 0;
    mockWorker.state.requestImpl = null;
    mockWorker.state.acquireWriterImpl = null;
    mockWorker.state.releaseWriterImpl = null;
    mockWorker.state.startImpl = null;
    mockWorker.state.evictImpl = null;
    bundleRoot = mkdtempSync(join(tmpdir(), 'mcp-coder-worker-pool-'));
  });

  afterEach(async () => {
    await pool?.dispose();
    await drainLocalCoderShadowWrites();
    await __flushRuntimeEventLogsForTests();
    __resetRuntimeEventLogsForTests();
    pool = null;
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  async function resolveTestSessionRuntimeContext(sessionId: SessionId) {
    const bundlePath = join(bundleRoot, String(sessionId));
    mkdirSync(bundlePath, { recursive: true });
    return {
      sessionId,
      projectId: 1,
      projectRoot: bundleRoot,
      bundlePath,
    };
  }

  function createPool(
    controlPlaneStore: ControlPlaneAuthority | null = null,
  ): CoderWorkerPool {
    pool = new CoderWorkerPool({
      workerFile: 'mock-worker.js',
      dbPath: ':memory:',
      resolveSessionRuntimeContext: resolveTestSessionRuntimeContext,
      postRunLingerMs: 60_000,
      log: () => undefined,
      getControlPlaneStore: () => controlPlaneStore,
    });
    return pool;
  }

  it('rejects retired conversations before policy resolution, writer handoff, or worker startup', async () => {
    const sessionId = sid(97);
    const directory = join(bundleRoot, 'native-sessions', sessionId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'session.json'), '{}');
    const resolveRuntimePolicy = vi.fn();
    const handoffSessionWriter = vi.fn();
    pool = new CoderWorkerPool({
      workerFile: 'mock-worker.js',
      dbPath: join(bundleRoot, 'store.db'),
      resolveSessionRuntimeContext: resolveTestSessionRuntimeContext,
      resolveRuntimePolicy,
      handoffSessionWriter,
      log: () => undefined,
    });

    await expect(pool.runFresh(sessionId, { userMessage: 'continue' })).rejects.toMatchObject({
      code: 'RETIRED_CONVERSATION_FORMAT',
    });
    await expect(pool.pushUserMessage(sessionId, 'follow-up')).rejects.toMatchObject({
      code: 'RETIRED_CONVERSATION_FORMAT',
    });
    await expect(pool.readAgentTranscript(sessionId, 'retained-group')).rejects.toMatchObject({
      code: 'RETIRED_CONVERSATION_FORMAT',
    });
    expect(resolveRuntimePolicy).not.toHaveBeenCalled();
    expect(handoffSessionWriter).not.toHaveBeenCalled();
    expect(mockWorker.state.hosts).toHaveLength(0);
  });

  it('recreates an evicted worker for retained history without launching a model or run', async () => {
    const p = createPool();
    mockWorker.state.requestImpl = async type => type === 'readAgentTranscript' ? { ok: true, text: 'Retained result' } : { ok: true };
    await expect(p.readAgentTranscript(sid(99), 'retained-group', 1, 2000)).resolves.toMatchObject({ ok: true, text: 'Retained result' });
    const first = mockWorker.state.hosts[0];
    expect(first.bridge.requests.map(request => request.type)).not.toContain('runFresh');
    expect(first.opts).not.toHaveProperty('workerData.nativeChildHistory');
    await p.evict(sid(99));
    await expect(p.readAgentTranscript(sid(99), 'retained-group')).resolves.toMatchObject({ ok: true });
    expect(mockWorker.state.hosts).toHaveLength(2);
    expect(mockWorker.state.hosts[1].bridge.requests.map(request => request.type)).not.toContain('runFresh');
    await expect(p.readAgentTranscript(sid(98), '')).resolves.toMatchObject({ reason: 'invalid_reference' });
    expect(mockWorker.state.hosts).toHaveLength(2);
  });

  it('resolves one immutable policy and sends it with the worker attempt', async () => {
    const runtimePolicy = resolveRuntimePolicyV1({
      resolvedAt: '2026-08-05T20:00:00.000Z',
      operator: {
        revision: 'operator-test',
        values: { context: { toolResultChars: 48_000 } },
      },
    });
    pool = new CoderWorkerPool({
      workerFile: 'mock-worker.js',
      dbPath: ':memory:',
      resolveSessionRuntimeContext: resolveTestSessionRuntimeContext,
      resolveRuntimePolicy: () => runtimePolicy,
      postRunLingerMs: 60_000,
      log: () => undefined,
    });

    await pool.runFresh(sid(98), { userMessage: 'first' });

    expect(mockWorker.state.hosts[0].bridge.requests.at(-1)).toMatchObject({
      type: 'runFresh',
      payload: {
        runtimePolicy: {
          policyDigest: runtimePolicy.policyDigest,
          context: { toolResultChars: 48_000 },
        },
      },
    });
  });

  it('waits for the main writer handoff before spawning the session worker', async () => {
    let releaseHandoff!: () => void;
    let handoffStarted!: () => void;
    const handoffGate = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    const started = new Promise<void>((resolve) => {
      handoffStarted = resolve;
    });
    const handoffSessionWriter = vi.fn(async () => {
      handoffStarted();
      await handoffGate;
    });
    pool = new CoderWorkerPool({
      workerFile: 'mock-worker.js',
      dbPath: ':memory:',
      resolveSessionRuntimeContext: resolveTestSessionRuntimeContext,
      handoffSessionWriter,
      postRunLingerMs: 60_000,
      log: () => undefined,
    });

    const running = pool.runFresh(sid(99), { userMessage: 'first' });
    await started;

    expect(handoffSessionWriter).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: sid(99) }),
    );
    expect(mockWorker.state.hosts).toHaveLength(0);

    releaseHandoff();
    await running;
    expect(mockWorker.state.hosts).toHaveLength(1);
    expect(mockWorker.state.hosts[0].startCalls).toBe(1);
    expect(handoffSessionWriter).toHaveBeenCalledTimes(2);
    expect(mockWorker.state.hosts[0].bridge.requests[0]).toMatchObject({
      type: 'acquireSessionWriter',
      payload: {},
      opts: { timeoutMs: SESSION_WRITER_ACQUIRE_TIMEOUT_MS },
    });
    expect(SESSION_WRITER_ACQUIRE_TIMEOUT_MS).toBe(120_000);
  });

  it('routes provider persistence through the worker that owns the session', async () => {
    const p = createPool();
    await expect(
      p.swapProvider(sid(93), 'openai-chatgpt', 'gpt-5.6-sol'),
    ).resolves.toBe(false);

    await p.runFresh(sid(93), { userMessage: 'first' });
    await expect(
      p.swapProvider(sid(93), 'openai-chatgpt', 'gpt-5.6-sol'),
    ).resolves.toBe(true);
    expect(mockWorker.state.hosts[0].bridge.requests.at(-1)).toMatchObject({
      type: 'swapProvider',
      payload: {
        provider: 'openai-chatgpt',
        model: 'gpt-5.6-sol',
      },
    });
  });

  it('treats a model switch as activity and cancels post-run eviction', async () => {
    vi.useFakeTimers();
    try {
      pool = new CoderWorkerPool({
        workerFile: 'mock-worker.js',
        dbPath: ':memory:',
        resolveSessionRuntimeContext: resolveTestSessionRuntimeContext,
        postRunLingerMs: 1_000,
        log: () => undefined,
      });
      const bus = await pool.runFresh(sid(91), { userMessage: 'first' });
      const host = mockWorker.state.hosts[0];
      const runId = getRunId(bus);
      host.bridge.emitToPool('bus.end', {
        runId,
        event: 'done',
        data: { reason: 'completed' },
      });

      await expect(pool.swapProvider(sid(91), 'copilot', 'gpt-5.6-terra'))
        .resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(host.evictCalls).toBe(0);
      expect(pool.has(sid(91))).toBe(true);
    } finally {
      await pool?.dispose();
      pool = null;
      vi.useRealTimers();
    }
  });

  it('waits for an in-flight eviction before falling back to main-process persistence', async () => {
    const p = createPool();
    await p.runFresh(sid(90), { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];
    let releaseWriter!: () => void;
    mockWorker.state.releaseWriterImpl = async () => new Promise((resolve) => {
      releaseWriter = () => resolve({ ok: true });
    });

    const eviction = p.evict(sid(90));
    await vi.waitFor(() => expect(releaseWriter).toBeTypeOf('function'));
    const swap = p.swapProvider(sid(90), 'copilot', 'gpt-5.6-terra');

    expect(host.bridge.requests.some((request) => request.type === 'swapProvider')).toBe(false);
    releaseWriter();
    await eviction;
    await expect(swap).resolves.toBe(false);
    expect(host.bridge.requests.some((request) => request.type === 'swapProvider')).toBe(false);
  });

  it('routes live session settings through the worker writer', async () => {
    const p = createPool();
    await p.runFresh(sid(92), { userMessage: 'first' });

    await expect(
      p.stageManualAgentTransition(sid(92), 'build'),
    ).resolves.toBe(true);
    await expect(
      p.setToolPermissionMode(sid(92), 'unrestricted'),
    ).resolves.toBe(true);
    await expect(
      p.setToolOutputCapLevel(sid(92), 'ultra'),
    ).resolves.toBe(true);
    await expect(
      p.setRunLimits(sid(92), 80, 4),
    ).resolves.toBe(true);

    expect(mockWorker.state.hosts[0].bridge.requests.slice(-4)).toEqual([
      expect.objectContaining({
        type: 'stageManualAgentTransition',
        payload: { agent: 'build' },
      }),
      expect.objectContaining({
        type: 'setToolPermissionMode',
        payload: { mode: 'unrestricted' },
      }),
      expect.objectContaining({
        type: 'setToolOutputCapLevel',
        payload: { level: 'ultra' },
      }),
      expect.objectContaining({
        type: 'setRunLimits',
        payload: { maxTurns: 80, maxAutoContinues: 4 },
      }),
    ]);
  });

  it('deduplicates concurrent startup so one session never gets two worker writers', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    mockWorker.state.startImpl = async () => startGate;
    const p = createPool();

    const first = p.runFresh(sid(98), { userMessage: 'first' });
    const second = p.runFresh(sid(98), { userMessage: 'second' });
    await vi.waitFor(() => expect(mockWorker.state.hosts).toHaveLength(1));

    releaseStart();
    const results = await Promise.allSettled([first, second]);

    expect(mockWorker.state.hosts).toHaveLength(1);
    expect(mockWorker.state.hosts[0].startCalls).toBe(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('waits for writer release and full eviction before spawning a replacement', async () => {
    const p = createPool();
    await p.runFresh(sid(97), { userMessage: 'first' });
    const firstHost = mockWorker.state.hosts[0];
    let releaseEvict!: () => void;
    let evictStarted!: () => void;
    const evictGate = new Promise<void>((resolve) => {
      releaseEvict = resolve;
    });
    const evictEntered = new Promise<void>((resolve) => {
      evictStarted = resolve;
    });
    mockWorker.state.evictImpl = async (host) => {
      if (host === firstHost) {
        evictStarted();
        await evictGate;
      }
    };

    const eviction = p.evict(sid(97));
    await evictEntered;
    const replacement = p.runFresh(sid(97), { userMessage: 'second' });
    await Promise.resolve();

    expect(
      firstHost.bridge.requests.find((request) => request.type === 'releaseSessionWriter'),
    ).toMatchObject({ opts: { timeoutMs: 15_000 } });
    expect(mockWorker.state.hosts).toHaveLength(1);

    releaseEvict();
    await eviction;
    await replacement;

    expect(mockWorker.state.hosts).toHaveLength(2);
    expect(mockWorker.state.hosts[1].startCalls).toBe(1);
  });

  it('fails closed when the worker cannot acknowledge writer release', async () => {
    const p = createPool();
    await p.runFresh(sid(96), { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];
    mockWorker.state.releaseWriterImpl = async () => {
      throw new Error('writer drain timed out');
    };

    await expect(p.evict(sid(96))).rejects.toThrow('writer drain timed out');

    expect(p.has(sid(96))).toBe(true);
    expect(host.evictCalls).toBe(0);

    mockWorker.state.releaseWriterImpl = null;
    await p.evict(sid(96));
    expect(p.has(sid(96))).toBe(false);
    expect(host.evictCalls).toBe(1);
  });

  it('keeps attempt authority valid until the worker has acknowledged its drain', async () => {
    const storeSpies = { terminalizeRun: vi.fn(), interruptRun: vi.fn(), renewAttemptLease: vi.fn() };
    const p = createPool(storeSpies as unknown as ControlPlaneAuthority);
    const context = makeRunContext(95, 'draining');
    await p.runFresh(sid(95), { userMessage: 'first', controlPlaneRunContext: context });
    let release!: () => void;
    mockWorker.state.releaseWriterImpl = async () => {
      expect(p.getControlPlaneRunContext(sid(95))).toEqual(context);
      expect(storeSpies.terminalizeRun).not.toHaveBeenCalled();
      expect(storeSpies.interruptRun).not.toHaveBeenCalled();
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true };
    };
    const eviction = p.evict(sid(95));
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(p.getControlPlaneRunContext(sid(95))).toEqual(context);
    expect(mockWorker.state.hosts[0].evictCalls).toBe(0);
    release(); await eviction;
    expect(p.getControlPlaneRunContext(sid(95))).toBeNull();
    expect(storeSpies.interruptRun).toHaveBeenCalledTimes(1);
  });

  it('routes host session diagnostics through the active worker writer', async () => {
    const p = createPool();
    expect(
      await p.appendSessionEvent(sid(94), 'memory_distill', { created: 1 }),
    ).toBe(false);

    await p.runFresh(sid(94), { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];
    await expect(
      p.appendSessionEvent(sid(94), 'memory_distill', { created: 1 }),
    ).resolves.toBe(true);

    expect(host.bridge.requests.at(-1)).toMatchObject({
      type: 'appendSessionEvent',
      payload: {
        event: 'memory_distill',
        payload: { created: 1 },
      },
      opts: { timeoutMs: 15_000 },
    });
  });

  it('reclaims the exact crashed isolate lease before allowing a replacement', async () => {
    const p = createPool();
    await p.runFresh(sid(95), { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];
    const hostOpts = host.opts as {
      workerData: {
        sessionContext: {
          bundlePath: string;
          writerOwnerId: string;
        };
      };
      maxRestarts: number;
      onExit?: (code: number, planned: boolean) => void;
      onCrash?: (error: Error) => void;
    };
    const { bundlePath, writerOwnerId } = hostOpts.workerData.sessionContext;
    const eventsPath = join(bundlePath, 'events');
    const leasePath = join(eventsPath, 'writer.lease');
    mkdirSync(eventsPath, { recursive: true });
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        schema_version: 1,
        token: randomUUID(),
        fence: 1,
        pid: process.pid,
        owner_id: writerOwnerId,
        owner_host: 'test',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      })}\n`,
    );

    expect(hostOpts.maxRestarts).toBe(0);
    hostOpts.onExit?.(1, false);
    hostOpts.onCrash?.(new Error('worker crashed'));
    const replacement = p.runFresh(sid(95), { userMessage: 'second' });

    await replacement;
    expect(existsSync(leasePath)).toBe(false);
    expect(mockWorker.state.hosts).toHaveLength(2);
  });

  it('reclaims a residual owner lease after a planned worker eviction', async () => {
    const p = createPool();
    await p.runFresh(sid(92), { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];
    const hostOpts = host.opts as {
      workerData: {
        sessionContext: {
          bundlePath: string;
          writerOwnerId: string;
        };
      };
    };
    const { bundlePath, writerOwnerId } = hostOpts.workerData.sessionContext;
    const eventsPath = join(bundlePath, 'events');
    const leasePath = join(eventsPath, 'writer.lease');
    mkdirSync(eventsPath, { recursive: true });
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        schema_version: 1,
        token: randomUUID(),
        fence: 1,
        pid: process.pid,
        owner_id: writerOwnerId,
        owner_host: 'test',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      })}\n`,
    );

    // The mocked release RPC acknowledges without touching the lease. The
    // coordinator must still clean up the exact owner after host eviction.
    await p.evict(sid(92));

    expect(host.evictCalls).toBe(1);
    expect(existsSync(leasePath)).toBe(false);
    expect(p.has(sid(92))).toBe(false);
  });

  it('reclaims the exact owner lease when writer acquisition fails during startup', async () => {
    const p = createPool();
    let leasePath = '';

    mockWorker.state.acquireWriterImpl = async () => {
      const host = mockWorker.state.hosts.at(-1)!;
      const hostOpts = host.opts as {
        workerData: {
          sessionContext: {
            bundlePath: string;
            writerOwnerId: string;
          };
        };
      };
      const { bundlePath, writerOwnerId } = hostOpts.workerData.sessionContext;
      const eventsPath = join(bundlePath, 'events');
      leasePath = join(eventsPath, 'writer.lease');
      mkdirSync(eventsPath, { recursive: true });
      writeFileSync(
        leasePath,
        `${JSON.stringify({
          schema_version: 1,
          token: randomUUID(),
          fence: 1,
          pid: process.pid,
          owner_id: writerOwnerId,
          owner_host: 'test',
          acquired_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        })}\n`,
      );
      throw new Error('writer recovery exceeded its startup budget');
    };

    await expect(
      p.runFresh(sid(91), { userMessage: 'first' }),
    ).rejects.toThrow('writer recovery exceeded its startup budget');

    expect(mockWorker.state.hosts[0].evictCalls).toBe(1);
    expect(existsSync(leasePath)).toBe(false);
    expect(p.has(sid(91))).toBe(false);

    mockWorker.state.acquireWriterImpl = null;
    await expect(
      p.runFresh(sid(91), { userMessage: 'retry' }),
    ).resolves.toBeDefined();
    expect(mockWorker.state.hosts).toHaveLength(2);
  });

  function makeRunContext(value: number, tag: string): ControlPlaneRunContext {
    const sessionId = sid(value);
    return {
      sessionId,
      commandId: asSessionCommandId(randomUUID()),
      correlationId: asCorrelationId(randomUUID()),
      actor: { actorId: 'local-user', actorType: 'user', source: 'http' },
      agentRunId: asAgentRunId(randomUUID()),
      attemptId: asAgentRunAttemptId(randomUUID()),
      executorOwnerId: `coder-worker:${sessionId}:${tag}`,
      fencingEpoch: 1,
    };
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

    const bus1 = await p.runFresh(sid(7), { userMessage: 'first' });
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

    const bus2 = await p.runFresh(sid(7), { userMessage: 'second' });
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
      renewAttemptLease: vi.fn(),
    };
    const context = makeRunContext(71, 'failure-terminal');
    const p = createPool(storeSpies as unknown as ControlPlaneAuthority);
    const bus = await p.runFresh(sid(71), {
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
    await p.runFresh(sid(70), { userMessage: 'first' });

    const opts = mockWorker.state.hosts[0].opts as {
      resourceLimits?: { maxOldGenerationSizeMb?: number };
    };
    expect(opts.resourceLimits?.maxOldGenerationSizeMb).toBe(1_024);
  });

  it('ignores late events and terminal signals from an old runId', async () => {
    const p = createPool();

    const bus1 = await p.runFresh(sid(8), { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];
    const runId1 = getRunId(bus1);
    host.bridge.emitToPool('bus.end', {
      runId: runId1,
      event: 'done',
      data: { reason: 'completed' },
    });

    const bus2 = await p.runFresh(sid(8), { userMessage: 'second' });
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

    await expect(p.runFresh(sid(9), { userMessage: 'first' })).rejects.toThrow('run setup failed');
    const failedBus = p.getBus(sid(9));
    expect(failedBus?.ended).toBe(true);

    mockWorker.state.requestImpl = null;
    const bus2 = await p.runFresh(sid(9), { userMessage: 'second' });

    expect(bus2).not.toBe(failedBus);
    expect(bus2.ended).toBe(false);
    expect(mockWorker.state.hosts[0].bridge.requests.filter((request) => request.type === 'runFresh')).toHaveLength(2);
  });

  it('drains an unacknowledged startup before revoking authority or admitting a replacement', async () => {
    const store = { terminalizeRun: vi.fn(), interruptRun: vi.fn(), renewAttemptLease: vi.fn() };
    const p = createPool(store as unknown as ControlPlaneAuthority);
    const context = makeRunContext(92, 'lost-start-ack');
    let release!: () => void;
    mockWorker.state.requestImpl = async () => { throw Object.assign(new Error('start ACK lost'), { code: 'request_timeout' }); };
    mockWorker.state.releaseWriterImpl = async () => {
      await new Promise<void>(resolve => { release = resolve; }); return { ok: true };
    };
    const starting = p.runFresh(sid(92), { userMessage: 'first', controlPlaneRunContext: context });
    const rejected = expect(starting).rejects.toThrow('start ACK lost');
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(p.getControlPlaneRunContext(sid(92))).toEqual(context);
    expect(store.interruptRun).not.toHaveBeenCalled();
    expect(mockWorker.state.hosts[0].evictCalls).toBe(0);
    release(); await rejected;
    expect(p.has(sid(92))).toBe(false);
    expect(mockWorker.state.hosts[0].evictCalls).toBe(1);
    mockWorker.state.requestImpl = null; mockWorker.state.releaseWriterImpl = null;
    await p.runFresh(sid(92), { userMessage: 'second' });
    expect(mockWorker.state.hosts).toHaveLength(2);
  });

  it('retains an unconfirmed startup and prevents replacement when drain also loses its ACK', async () => {
    const store = { terminalizeRun: vi.fn(), interruptRun: vi.fn(), renewAttemptLease: vi.fn() };
    const p = createPool(store as unknown as ControlPlaneAuthority);
    const context = makeRunContext(91, 'lost-start-and-drain');
    mockWorker.state.requestImpl = async () => { throw Object.assign(new Error('ACK lost'), { code: 'request_timeout' }); };
    mockWorker.state.releaseWriterImpl = async () => { throw new Error('drain ACK lost'); };
    await expect(p.runFresh(sid(91), { userMessage: 'first', controlPlaneRunContext: context }))
      .rejects.toMatchObject({ code: 'CODER_STARTUP_UNCERTAIN' });
    expect(p.getControlPlaneRunContext(sid(91))).toEqual(context);
    expect(p.isRunning(sid(91))).toBe(true);
    expect(store.interruptRun).not.toHaveBeenCalled();
    await expect(p.runFresh(sid(91), { userMessage: 'second' })).rejects.toMatchObject({ code: 'CODER_STARTUP_UNCERTAIN' });
    expect(mockWorker.state.hosts).toHaveLength(1);
    expect(mockWorker.state.hosts[0].evictCalls).toBe(0);
    mockWorker.state.releaseWriterImpl = null;
    await p.evict(sid(91));
  });

  it('renews a silent active run for eleven minutes without depending on bus events', async () => {
    vi.useFakeTimers();
    try {
      const renewAttemptLease = vi.fn();
      const storeSpies = {
        renewAttemptLease,
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
      };
      const context = makeRunContext(18, 'silent');
      const p = createPool(storeSpies as unknown as ControlPlaneAuthority);
      const bus = await p.runFresh(sid(18), {
        userMessage: 'long silent provider call',
        controlPlaneRunContext: context,
      });

      await vi.advanceTimersByTimeAsync(11 * 60_000);

      expect(bus.ended).toBe(false);
      expect(p.getControlPlaneRunContext(sid(18))).toEqual(context);
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
        renewAttemptLease,
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
      };
      const oldContext = makeRunContext(19, 'old');
      const replacementContext = {
        ...makeRunContext(19, 'replacement'),
        fencingEpoch: 2,
      } as ControlPlaneRunContext;
      const p = createPool(storeSpies as unknown as ControlPlaneAuthority);

      await p.runFresh(sid(19), { userMessage: 'old', controlPlaneRunContext: oldContext });
      await p.evict(sid(19));
      await p.runFresh(sid(19), {
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
        renewAttemptLease: vi.fn(() => {
          throw new Error('attempt was fenced');
        }),
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
      };
      const context = makeRunContext(20, 'authority-loss');
      const p = createPool(storeSpies as unknown as ControlPlaneAuthority);
      const bus = await p.runFresh(sid(20), {
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
      expect(p.has(sid(20))).toBe(false);

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
    const activeContext = makeRunContext(14, 'active');
    const rejectedContext = {
      ...makeRunContext(14, 'rejected'),
      fencingEpoch: activeContext.fencingEpoch,
    };
    const p = createPool(storeSpies as unknown as ControlPlaneAuthority);
    await p.runFresh(sid(14), { userMessage: 'first', controlPlaneRunContext: activeContext });

    await expect(p.runFresh(sid(14), {
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
    expect(p.getControlPlaneRunContext(sid(14))).toEqual(activeContext);
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
    const context = makeRunContext(9, 'dispatch-failed');
    const p = createPool(storeSpies as unknown as ControlPlaneAuthority);
    mockWorker.state.requestImpl = async () => {
      throw new Error('run setup failed');
    };

    await expect(p.runFresh(sid(9), {
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
    expect(p.getControlPlaneRunContext(sid(9))).toBeNull();
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
        renewAttemptLease: vi.fn(),
      };
      const context = makeRunContext(13, 'lifecycle');
      const p = createPool(storeSpies as unknown as ControlPlaneAuthority);
      const bus = await p.runFresh(sid(13), {
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
      expect(p.getControlPlaneRunContext(sid(13))).toEqual(context);

      host.bridge.emitToPool('bus.event', {
        runId,
        event: 'run_started',
        data: { runId: 'runner-worker-13' },
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

      expect(storeSpies.markRunStarted).toHaveBeenCalledWith(context, 'runner-worker-13');
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
      expect(p.getControlPlaneRunContext(sid(13))).toBeNull();
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
        renewAttemptLease: vi.fn(),
        appendRuntimeEvent: journalAppend,
      };
      const context = makeRunContext(15, 'extended-vocabulary');
      const p = createPool(storeSpies as unknown as ControlPlaneAuthority);
      const bus = await p.runFresh(sid(15), { userMessage: 'first', controlPlaneRunContext: context });
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
        renewAttemptLease: vi.fn(),
        appendRuntimeEvent: journalAppend,
      };
      const context = makeRunContext(16, 'flags-off');
      const p = createPool(storeSpies as unknown as ControlPlaneAuthority);
      const bus = await p.runFresh(sid(16), { userMessage: 'first', controlPlaneRunContext: context });
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
    try {
      const runContext = makeRunContext(17, 'diverge');
      const store = {
        terminalizeRun: vi.fn(),
        interruptRun: vi.fn(),
        getCommand: vi.fn(() => ({
          status: 'failed',
          reasonCode: 'worker-crashed',
          agentRunId: runContext.agentRunId,
        })),
        getRun: vi.fn(() => ({
          status: 'interrupted',
          terminalReason: 'worker-crashed',
        })),
        renewAttemptLease: vi.fn(),
        recordDivergences: vi.fn(
          (_context: unknown, divergences: readonly unknown[]) =>
            divergences.length,
        ),
      };

      pool = new CoderWorkerPool({
        workerFile: 'mock-worker.js',
        dbPath: ':memory:',
        resolveSessionRuntimeContext: resolveTestSessionRuntimeContext,
        postRunLingerMs: 60_000,
        log: () => undefined,
        getControlPlaneStore: () =>
          store as unknown as ControlPlaneAuthority,
      });
      const bus = await pool.runFresh(sid(17), { userMessage: 'first', controlPlaneRunContext: runContext });
      const host = mockWorker.state.hosts[0];
      const runId = getRunId(bus);
      host.bridge.emitToPool('bus.end', { runId, event: 'done', data: { reason: 'completed' } });

      await vi.waitFor(() =>
        expect(store.recordDivergences).toHaveBeenCalledOnce(),
      );
      const divergences = store.recordDivergences.mock.calls[0]?.[1] as
        | Array<{ kind: string }>
        | undefined;
      expect(divergences?.map((row) => row.kind).sort()).toEqual([
        'command_status_mismatch',
        'run_status_mismatch',
      ]);
      expect(snapshotCoderControlPlaneShadowMetrics().divergences).toBe(2);
    } finally {
      resetCoderControlPlaneShadowMetricsForTests();
      if (previousControlPlane === undefined) delete process.env.CODER_CONTROL_PLANE_SHADOW;
      else process.env.CODER_CONTROL_PLANE_SHADOW = previousControlPlane;
      if (previousJournal === undefined) delete process.env.CODER_RUNTIME_JOURNAL_SHADOW;
      else process.env.CODER_RUNTIME_JOURNAL_SHADOW = previousJournal;
    }
  });

  it('asks the active worker to persist a follow-up before enqueueing it', async () => {
    const p = createPool();
    await p.runFresh(sid(10), { userMessage: 'first' });
    const host = mockWorker.state.hosts[0];

    await expect(
      p.pushUserMessage(
        sid(10),
        'follow-up',
        ['skill-a'],
        'message:test-follow-up',
        [{
          name: 'notes.txt',
          mediaType: 'text/plain',
          text: 'attachment details',
        }],
      ),
    ).resolves.toBe(42);

    expect(host.bridge.requests.at(-1)).toMatchObject({
      type: 'pushUserMessage',
      payload: {
        content: 'follow-up',
        selectedSkillIds: ['skill-a'],
        operationId: 'message:test-follow-up',
        attachments: [{
          name: 'notes.txt',
          mediaType: 'text/plain',
          text: 'attachment details',
        }],
      },
    });
  });

});
