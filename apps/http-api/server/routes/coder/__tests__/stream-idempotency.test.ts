/**
 * Route-level idempotency tests for POST /messages and POST /continue.
 *
 * A `ReconnectingSSEClient` retry re-POSTs the body (with a stable
 * `client_msg_id`). These tests assert the retry is deduped into a bus replay
 * instead of re-running the worker-persist/push/spawn side effects, and that the
 * /continue live-run hardening never spins a second concurrent runner.
 *
 * The route is mounted against fake deps/runtime (no DB, no real worker). The
 * mandatory worker pool is mocked at its route-facing RPC boundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';

const { poolMock, workerEntries } = vi.hoisted(() => ({
  workerEntries: new Map<SessionId, unknown>(),
  poolMock: {
    getBus: vi.fn(),
    runFresh: vi.fn(),
    isWaitingForInput: vi.fn(),
    interruptWait: vi.fn(),
    pushUserMessage: vi.fn(),
  },
}));

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => poolMock,
}));


import { mountCoderStreamRoutes } from '../stream.js';
import { createBus, markEnded, publish, type CoderRunBus } from '../../../../coder-bus.js';
import { RecentMessageKeys } from '../../recent-message-keys.js';
import { SessionRecoveryError } from '../../../../control-plane-recovery-error.js';
import { CoderTurnEndedError, CoderWorkerBootError, CoderWorkerDrainError } from '../../../../sse/coder-runtime-errors.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

const SESSION_ID = asSessionId('77777777-7777-4777-8777-777777777777');

function makeRunner() {
  const state = { waiting: false };
  const pushCalls: string[] = [];
  const pushExtras: unknown[] = [];
  return {
    runner: {
      isWaitingForInput: () => state.waiting,
      interruptWait: () => true,
      pushUserMessage: (content: string, extras: unknown) => {
        pushCalls.push(content);
        pushExtras.push(extras);
      },
    },
    state,
    pushCalls,
    pushExtras,
  };
}

const runners = new Map<SessionId, ReturnType<typeof makeRunner>>();

function preflightHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (((hash << 5) + hash) + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function setup(
  recentMessageKeys: Pick<
    RecentMessageKeys,
    'claim' | 'lookup' | 'record' | 'recordTerminal' | 'rejectClaim'
  > = new RecentMessageKeys(),
  opts: {
    sessionAgent?: string | null;
    customAgents?: unknown[];
    globalFresh?: boolean;
    projectFresh?: boolean;
    pendingTransition?: {
      sessionId: SessionId;
      fromAgent: string | null;
      toAgent: string | null;
      updatedAt: string;
    } | null;
    ensureStructuralReady?: () => Promise<{
      status: 'ready' | 'aborted' | 'disabled' | 'timeout' | 'error' | 'too_large';
      phase: 'none' | 'scanning' | 'structural_indexing' | 'structural_ready' | 'semantic_indexing' | 'semantic_ready' | 'too_large' | 'error';
      error?: string;
    }>;
    controlPlaneCommands?: Map<string, Record<string, unknown>>;
    controlPlaneUnavailable?: boolean;
    initialMessageCount?: number;
    unresolvedToolOutcome?: boolean;
    preflightSeedJson?: string | null;
    taskPreflightRun?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const appendCalls: unknown[] = [];
  const inputCalls: unknown[] = [];
  const consumeTransitionCalls: SessionId[] = [];
  const acceptCalls: unknown[] = [];
  const controlPlaneCommands =
    opts.controlPlaneCommands ?? new Map<string, Record<string, unknown>>();
  let pendingTransition = opts.pendingTransition ?? null;
  const projectId = opts.globalFresh || opts.projectFresh ? 99 : null;
  let messageCount = opts.initialMessageCount ?? (projectId != null ? 0 : 1);
  let preflightSeedJson = opts.preflightSeedJson ?? null;
  const preflightSeedWrites: Array<string | null> = [];
  const taskPreflightRun = opts.taskPreflightRun ?? vi.fn(async () => ({ status: 'unconfigured' }));
  const ensureFresh = vi.fn();
  const ensureStructuralReady = vi.fn(opts.ensureStructuralReady ?? (async () => ({
    status: 'ready' as const,
    phase: 'structural_ready' as const,
  })));
  const sessionStore = {
    getSession: (id: SessionId) => ({
      id,
      project_id: projectId,
      status: 'idle',
      agent: opts.sessionAgent ?? null,
      is_global: !!opts.globalFresh,
      compaction_summary: null,
      preflight_seed_json: preflightSeedJson,
    }),
    getMessageCount: () => messageCount,
    appendMessage: (input: { session_id: SessionId; message: unknown }) => {
      appendCalls.push(input.message);
      messageCount += 1;
      return appendCalls.length;
    },
    consumePendingAgentTransition: (id: SessionId) => {
      consumeTransitionCalls.push(id);
      const transition = pendingTransition;
      pendingTransition = null;
      return transition;
    },
    recordSessionInput: (input: unknown) => {
      inputCalls.push(input);
      return input;
    },
    setSessionPreflightSeed: (_id: SessionId, value: string | null) => {
      preflightSeedJson = value;
      preflightSeedWrites.push(value);
    },
    loadSessionWithMessages: (id: SessionId) => ({
      session: { id, project_id: projectId, agent: opts.sessionAgent ?? null },
      messages: [{ role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', ...(opts.unresolvedToolOutcome ? { effect_outcome: 'unknown' } : {}) }] }],
    }),
  };
  const deps = {
    sessionStore,
    providerStore: {
      getProvider: () => undefined,
      listModels: () => [],
      getAppSetting: (key: string) => key === 'coder_custom_agents_v1' && opts.customAgents
        ? JSON.stringify(opts.customAgents)
        : null,
    },
    db: {
      getProject: () => projectId == null
        ? null
        : ({ id: projectId, name: 'Fake project', root_path: 'D:/fake' }),
    },
    projectIndexService: {
      ensureFresh,
      ensureStructuralReady,
    },
    semanticCoordinator: {
      acquireCodeProjectLease: () => () => {},
    },
    taskPreflight: {
      run: taskPreflightRun,
      generateSessionTitle: async () => ({ status: 'unconfigured' }),
    },
    buildAgentDecisionRuntimeOptions: () => ({}),
    buildToolSelectionFilter: () => undefined,
    controlPlaneStore: opts.controlPlaneUnavailable ? null : {
      acceptCommand: (input: {
        command: Record<string, unknown> & {
          commandId: string;
          sessionId: string;
          kind: string;
          idempotencyKey: string;
        };
        payloadHash: string;
        idempotencyKindAliases?: string[];
      }) => {
        acceptCalls.push(input);
        const key = `${input.command.sessionId}:${input.command.kind}:${input.command.idempotencyKey}`;
        const existing = [
          input.command.kind,
          ...(input.idempotencyKindAliases ?? []),
        ]
          .map((kind) => controlPlaneCommands.get(
            `${input.command.sessionId}:${kind}:${input.command.idempotencyKey}`,
          ))
          .find((candidate) => candidate != null);
        if (existing) {
          return existing.payloadHash === input.payloadHash
            ? { kind: 'existing', command: existing }
            : { kind: 'payload_conflict', command: existing };
        }
        const command = {
          ...input.command,
          status: 'accepted',
          sessionVersion: 1,
          payloadHash: input.payloadHash,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        controlPlaneCommands.set(key, command);
        return { kind: 'accepted', command };
      },
      terminalizeCommand: (input: {
        context: { commandId: string };
        status: string;
        reason: string;
      }) => {
        for (const command of controlPlaneCommands.values()) {
          if (command.commandId === input.context.commandId) {
            command.status = input.status;
            command.reasonCode = input.reason;
          }
        }
      },
      bindCommandExecution: (
        context: { commandId: string },
        busId: string,
      ) => {
        for (const command of controlPlaneCommands.values()) {
          if (command.commandId === context.commandId) {
            command.status = 'running';
            command.result = { busId };
          }
        }
      },
    },
  } as unknown as ServerDeps;

  const runtime = {
    activeRuns: new Map<SessionId, CoderRunBus>(),
    findPendingInteraction: async () => null,
    findDanglingToolUse: async () => null,
    coderPipelineRegistry: {},
    recentMessageKeys,
  } as unknown as CoderRuntime;

  const app = new HttpRouter();
  mountCoderStreamRoutes(app, deps, runtime);

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  return {
    app,
    deps,
    runtime,
    activeRuns: workerEntries as Map<SessionId, CoderRunBus>,
    appendCalls,
    inputCalls,
    preflightSeedWrites,
    taskPreflightRun,
    ensureFresh,
    ensureStructuralReady,
    consumeTransitionCalls,
    acceptCalls,
    controlPlaneCommands,
    post,
  };
}

/** Seed a live worker run and its mocked control surface. */
function seedLiveRun(activeRuns: Map<SessionId, CoderRunBus>, id: SessionId) {
  const bus = createBus(new AbortController());
  const r = makeRunner();
  activeRuns.set(id, bus);
  runners.set(id, r);
  return { bus, ...r };
}

beforeEach(() => {
  vi.clearAllMocks();
  workerEntries.clear();
  runners.clear();
  poolMock.getBus.mockImplementation((id: SessionId) => workerEntries.get(id) ?? null);
  poolMock.runFresh.mockImplementation(async (id: SessionId) => {
    const bus = createBus(new AbortController());
    workerEntries.set(id, bus);
    return bus;
  });
  poolMock.isWaitingForInput.mockImplementation(async (id: SessionId) => runners.get(id)?.state.waiting ?? false);
  poolMock.interruptWait.mockImplementation(async (id: SessionId) => {
    const runner = runners.get(id);
    if (runner) runner.state.waiting = false;
  });
  poolMock.pushUserMessage.mockImplementation(async (
    id: SessionId,
    content: string,
    selectedSkillIds?: string[],
    _operationId?: string,
  ) => {
    const roundMessageId = 42;
    runners.get(id)?.runner.pushUserMessage(content, { selectedSkillIds, roundMessageId });
    return roundMessageId;
  });
  vi.stubEnv('CODER_PREFLIGHT', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /messages idempotency', () => {
  it('acknowledges live messages as JSON without opening another stream or restarting the worker', async () => {
    const h = setup();
    const { bus, pushCalls } = seedLiveRun(h.activeRuns, SESSION_ID);
    const body = { content: 'guidance', client_msg_id: 'receipt-live', interject: true, response_mode: 'json' };
    const [first, retry] = await Promise.all([h.post(`/api/coder/sessions/${SESSION_ID}/messages`, body), h.post(`/api/coder/sessions/${SESSION_ID}/messages`, body)]);
    expect(await first.json()).toMatchObject({ accepted: true, active: true, bus_id: bus.busId });
    expect(await retry.json()).toMatchObject({ accepted: true, active: true, bus_id: bus.busId });
    expect(pushCalls).toEqual(['guidance']);
    expect(poolMock.runFresh).not.toHaveBeenCalled();
    expect(bus.subscribers.size).toBe(0);
  });

  it('returns a fresh-run receipt and recovers its terminal outcome without resending', async () => {
    const h = setup();
    const body = { content: 'next task', client_msg_id: 'receipt-fresh', response_mode: 'json', only_when_idle: true };
    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, body);
    expect(await response.json()).toMatchObject({ accepted: true, active: true, started: true });
    const liveRetry = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, body);
    expect(await liveRetry.json()).toMatchObject({ accepted: true, active: true });
    expect(poolMock.runFresh).toHaveBeenCalledOnce();
    const bus = h.activeRuns.get(SESSION_ID)!;
    markEnded(bus, 'done', { reason: 'completed' });
    const retry = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, body);
    expect(await retry.json()).toMatchObject({ accepted: true, active: false });
    expect(poolMock.runFresh).toHaveBeenCalledOnce();
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('does not turn a parked task into steering when the server is still busy', async () => {
    const h = setup();
    const { bus } = seedLiveRun(h.activeRuns, SESSION_ID);
    const body = { content: 'later', client_msg_id: 'receipt-busy', response_mode: 'json', only_when_idle: true };
    const busy = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, body);
    expect(await busy.json()).toEqual({ accepted: false, busy: true, bus_id: bus.busId });
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
    expect(h.acceptCalls).toHaveLength(1);
    markEnded(bus, 'done', { reason: 'completed' });
    const next = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, { ...body, client_msg_id: 'receipt-busy-retry' });
    expect(await next.json()).toMatchObject({ accepted: true, started: true });
    expect(poolMock.runFresh).toHaveBeenCalledOnce();
  });

  it('passes attachments and skills into a live message with a stable operation identity', async () => {
    const h = setup(); seedLiveRun(h.activeRuns, SESSION_ID);
    const attachments = [{ name: 'notes.txt', mediaType: 'text/plain', text: 'details' }];
    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'inspect this', client_msg_id: 'receipt-attachment', response_mode: 'json', interject: true,
      attachments, selected_skill_ids: ['skill-1'],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(poolMock.pushUserMessage).toHaveBeenCalledWith(SESSION_ID, 'inspect this', ['skill-1'], expect.any(String), attachments);
  });

  it('persists steering before waking an interactive wait', async () => {
    const h = setup(); const live = seedLiveRun(h.activeRuns, SESSION_ID); live.state.waiting = true;
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    poolMock.pushUserMessage.mockImplementationOnce(async () => { await persisted; return 42; });
    const request = h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'new instructions', client_msg_id: 'receipt-waiting', response_mode: 'json', interject: true,
    });
    await vi.waitFor(() => expect(poolMock.pushUserMessage).toHaveBeenCalledOnce());
    expect(poolMock.interruptWait).not.toHaveBeenCalled();
    release();
    expect(await (await request).json()).toMatchObject({ accepted: true });
    expect(poolMock.interruptWait).toHaveBeenCalledOnce();
  });

  it('keeps rejected live delivery visible instead of claiming successful admission', async () => {
    const h = setup(); seedLiveRun(h.activeRuns, SESSION_ID);
    poolMock.pushUserMessage.mockRejectedValueOnce(new Error('write failed'));
    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'guidance', client_msg_id: 'receipt-failure', response_mode: 'json', interject: true,
    });
    expect(response.status).toBe(500);
    expect(poolMock.runFresh).not.toHaveBeenCalled();
  });

  it('creates authority for a fresh worker with shadow flags off and retains it for live follow-ups', async () => {
    vi.stubEnv('CODER_CONTROL_PLANE_SHADOW', '0');
    vi.stubEnv('CODER_AGENT_RUN_STORE_SHADOW', '0');
    vi.stubEnv('CODER_AGENT_RUN_STORE_ENFORCE', '0');
    const h = setup();
    expect((await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, { content: 'first', client_msg_id: 'fresh' })).status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledOnce());
    expect(h.acceptCalls[0]).toMatchObject({ run: {
      agentRunId: expect.any(String), attemptId: expect.any(String), executorOwnerId: expect.any(String),
    } });
    expect((await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, { content: 'follow-up', client_msg_id: 'follow-up' })).status).toBe(200);
    expect(h.acceptCalls[1]).toMatchObject({ run: undefined });
    expect(poolMock.runFresh).toHaveBeenCalledOnce();
  });

  it('reuses a matching fresh preflight cache without adding lifecycle metadata', async () => {
    vi.stubEnv('CODER_PREFLIGHT', '1');
    const content = 'fix the retry race';
    const seed = { taskKind: 'bugfix', profile: 'navigate' as const };
    const h = setup(new RecentMessageKeys(), {
      projectFresh: true,
      preflightSeedJson: JSON.stringify({
        h: preflightHash(`${content}\0`),
        seed,
      }),
    });

    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content,
      client_msg_id: 'preflight-cache-upgrade',
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(h.taskPreflightRun).not.toHaveBeenCalled();
    expect(h.preflightSeedWrites).toHaveLength(0);
    expect(poolMock.runFresh).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ preflight: seed }),
    );
  });

  it('reads a cached seed written before tool pins were retired, without passing the pins on', async () => {
    vi.stubEnv('CODER_PREFLIGHT', '1');
    const content = 'fix the retry race';
    const h = setup(new RecentMessageKeys(), {
      projectFresh: true,
      preflightSeedJson: JSON.stringify({
        h: preflightHash(`${content}\0`),
        seed: { taskKind: 'bugfix', profile: 'navigate', pinTools: ['read_file', 'ext_srv__call'] },
      }),
    });

    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content,
      client_msg_id: 'preflight-legacy-pins',
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(h.taskPreflightRun).not.toHaveBeenCalled();
    const call = poolMock.runFresh.mock.calls[0]![1] as { preflight?: unknown };
    expect(call.preflight).toEqual({ taskKind: 'bugfix', profile: 'navigate' });
  });

  it('records the preflight trail without tool pins', async () => {
    vi.stubEnv('CODER_PREFLIGHT', '1');
    const taskPreflightRun = vi.fn(async () => ({
      status: 'ok' as const,
      seed: { taskKind: 'bugfix', profile: 'navigate' as const },
      raw: '{}',
      latencyMs: 3,
    }));
    const h = setup(new RecentMessageKeys(), { projectFresh: true, taskPreflightRun });

    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'fix the login race',
      client_msg_id: 'preflight-trail',
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    const trail = h.inputCalls.find((input) => (input as { kind?: string }).kind === 'preflight') as
      { meta?: Record<string, unknown> } | undefined;
    expect(trail?.meta).toMatchObject({ status: 'ok', task_kind: 'bugfix', profile: 'navigate' });
    expect(trail?.meta).not.toHaveProperty('tools');
    expect(trail?.meta).not.toHaveProperty('ext_tools');
  });

  it('rejects a concurrent payload conflict before duplicate preflight or run side effects', async () => {
    vi.stubEnv('CODER_PREFLIGHT', '1');
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const taskPreflightRun = vi.fn(async () => {
      await preflightGate;
      return { status: 'unconfigured' as const };
    });
    const h = setup(new RecentMessageKeys(), {
      projectFresh: true,
      taskPreflightRun,
    });

    const owner = h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'payload-a',
      client_msg_id: 'same-key',
    });
    await vi.waitFor(() => expect(taskPreflightRun).toHaveBeenCalledTimes(1));
    const conflict = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'payload-b',
      client_msg_id: 'same-key',
    });

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' });
    expect(h.acceptCalls).toHaveLength(1);
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.runFresh).not.toHaveBeenCalled();
    releasePreflight();
    expect((await owner).status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
  });

  it('keeps 32 pre-bus owners authoritative across waiter TTL and rejects capacity before durable accept', async () => {
    vi.stubEnv('CODER_PREFLIGHT', '1');
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const taskPreflightRun = vi.fn(async () => {
      await preflightGate;
      return { status: 'unconfigured' as const };
    });
    const keys = new RecentMessageKeys({
      ttlMs: 60_000,
      pendingWaitMs: 25,
      maxPerSession: 32,
    });
    const h = setup(keys, {
      projectFresh: true,
      taskPreflightRun,
    });

    const owners = Array.from({ length: 32 }, (_, index) =>
      h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
        content: `owner-${index}`,
        client_msg_id: `owner-key-${index}`,
      }),
    );
    await vi.waitFor(
      () => expect(taskPreflightRun).toHaveBeenCalledTimes(32),
      { timeout: 3_000 },
    );
    expect(h.controlPlaneCommands.size).toBe(32);
    expect(poolMock.runFresh).not.toHaveBeenCalled();

    const overflow = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'overflow',
      client_msg_id: 'owner-key-32',
    });
    expect(overflow.status).toBe(503);
    expect(await overflow.json()).toMatchObject({
      code: 'IDEMPOTENCY_CAPACITY_EXHAUSTED',
      retry_after_ms: 25,
    });
    expect(overflow.headers.get('Retry-After')).toBe('1');
    expect(h.controlPlaneCommands.size).toBe(32);

    const retry = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'owner-0',
      client_msg_id: 'owner-key-0',
    });
    expect(retry.status).toBe(503);
    expect(retry.headers.get('Retry-After')).toBe('1');
    expect(await retry.json()).toMatchObject({
      code: 'IDEMPOTENCY_RETRY_LATER',
    });
    const firstCommand = [...h.controlPlaneCommands.values()].find(
      (command) => command.idempotencyKey === 'owner-key-0',
    );
    expect(firstCommand).toMatchObject({ status: 'accepted' });
    expect(firstCommand?.reasonCode).toBeUndefined();
    expect(h.acceptCalls).toHaveLength(32);

    releasePreflight();
    await Promise.all(owners);
  });

  it('fails closed before effects when command authority is unavailable, even without a client key', async () => {
    const h = setup(new RecentMessageKeys(), { controlPlaneUnavailable: true });

    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'must not execute',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'IDEMPOTENCY_AUTHORITY_UNAVAILABLE',
    });
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.runFresh).not.toHaveBeenCalled();
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('retries the same message after session storage recovers without caching the admission failure', async () => {
    const h = setup();
    vi.spyOn(h.deps.controlPlaneStore!, 'acceptCommand').mockRejectedValueOnce(
      new SessionRecoveryError(SESSION_ID, new Error('unreadable session directory')),
    );
    const body = { content: 'retry after storage recovery', client_msg_id: 'storage-retry', response_mode: 'json' };
    const first = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, body);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ code: 'SESSION_RECOVERY_UNAVAILABLE', session_id: SESSION_ID });
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.runFresh).not.toHaveBeenCalled();

    const retry = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ accepted: true, started: true });
    const replay = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, body);
    expect(replay.status).toBe(200);
    // Fresh input is persisted by the worker; the router must not append it.
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.runFresh).toHaveBeenCalledOnce();
    expect(h.controlPlaneCommands.size).toBe(1);
  });

  it('keeps a fresh command non-terminal until its exact bus outcome', async () => {
    const h = setup();
    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'long run',
      client_msg_id: 'long-running-key',
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    const command = [...h.controlPlaneCommands.values()][0]!;
    expect(command.status).toBe('running');
    expect(command.result).toEqual({ busId: h.activeRuns.get(SESSION_ID)!.busId });

    const bus = h.activeRuns.get(SESSION_ID)!;
    markEnded(bus, 'done', { reason: 'completed' });
    expect(command.status).toBe('succeeded');
  });

  it('never replays an unrelated session bus for a durable existing command', async () => {
    const transientOnly = {
      claim: () => ({ kind: 'owner' as const, token: Symbol('claim') }),
      lookup: () => undefined,
      record: () => false,
      recordTerminal: () => true,
      rejectClaim: () => {},
    };
    const h = setup(transientOnly);
    expect((await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'original',
      client_msg_id: 'durable-key',
    })).status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));

    const unrelated = createBus(new AbortController());
    h.activeRuns.set(SESSION_ID, unrelated);
    const retry = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'original',
      client_msg_id: 'durable-key',
    });
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('executor-bus-unavailable');
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1);
  });

  it('honors Last-Event-ID when replaying the exact durable bus after a route remount', async () => {
    const firstMount = setup();
    expect((await firstMount.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'original',
      client_msg_id: 'durable-cursor-key',
    })).status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    const exactBus = firstMount.activeRuns.get(SESSION_ID)!;
    publish(exactBus, 'worker_log', { marker: 'already-acknowledged' });
    publish(exactBus, 'text_delta', { marker: 'must-replay' });

    const remounted = setup(new RecentMessageKeys(), {
      controlPlaneCommands: firstMount.controlPlaneCommands,
    });
    const replay = await remounted.post(
      `/api/coder/sessions/${SESSION_ID}/messages`,
      { content: 'original', client_msg_id: 'durable-cursor-key' },
      { 'Last-Event-ID': '0' },
    );
    expect(replay.status).toBe(200);
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1);
    markEnded(exactBus, 'done', { reason: 'completed' });
    expect(await replay.text()).toContain('must-replay');
  });

  it('keeps the first-message command identity stable across append and route remount', async () => {
    const firstMount = setup(new RecentMessageKeys(), { initialMessageCount: 0 });
    expect((await firstMount.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'first message',
      client_msg_id: 'first-message-remount',
    })).status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(firstMount.acceptCalls[0]).toMatchObject({
      command: { kind: 'send_message' },
      idempotencyKindAliases: ['start'],
    });
    expect(firstMount.appendCalls).toHaveLength(0);

    const remounted = setup(new RecentMessageKeys(), {
      controlPlaneCommands: firstMount.controlPlaneCommands,
      initialMessageCount: 1,
    });
    const retry = await remounted.post(
      `/api/coder/sessions/${SESSION_ID}/messages`,
      { content: 'first message', client_msg_id: 'first-message-remount' },
      { 'Last-Event-ID': '-1' },
    );
    expect(retry.status).toBe(200);
    expect(firstMount.controlPlaneCommands.size).toBe(1);
    expect(remounted.appendCalls).toHaveLength(0);
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1);

    markEnded(firstMount.activeRuns.get(SESSION_ID)!, 'done', { reason: 'completed' });
    await retry.text();
  });

  it('persists a failure-class done signal as failed and replays an error terminal', async () => {
    const firstMount = setup();
    expect((await firstMount.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'will fail',
      client_msg_id: 'failure-ledger-key',
    })).status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    const bus = firstMount.activeRuns.get(SESSION_ID)!;
    const command = [...firstMount.controlPlaneCommands.values()][0]!;

    // Compatibility guard: an older worker can still send done + a failure
    // reason. The ledger must classify the semantic outcome, not the label.
    markEnded(bus, 'done', {
      reason: 'recovery_capped',
      error: 'provider recovery exhausted',
    });
    expect(command).toMatchObject({
      status: 'failed',
      reasonCode: 'recovery_capped',
    });

    const remounted = setup(new RecentMessageKeys(), {
      controlPlaneCommands: firstMount.controlPlaneCommands,
    });
    const retry = await remounted.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'will fail',
      client_msg_id: 'failure-ledger-key',
    });
    const replay = await retry.text();

    expect(retry.status).toBe(200);
    expect(replay).toContain('event: error');
    expect(replay).toContain('command-failed');
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1);
  });

  it('does not advance an in-memory duplicate beyond the client replay cursor', async () => {
    const h = setup();
    const live = seedLiveRun(h.activeRuns, SESSION_ID);
    publish(live.bus, 'worker_log', { marker: 'acknowledged' });
    publish(live.bus, 'worker_log', { marker: 'cursor-gap' });

    expect((await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'attach',
      client_msg_id: 'memory-cursor-key',
    })).status).toBe(200);
    publish(live.bus, 'text_delta', { marker: 'after-command' });

    const replay = await h.post(
      `/api/coder/sessions/${SESSION_ID}/messages`,
      { content: 'attach', client_msg_id: 'memory-cursor-key' },
      { 'Last-Event-ID': '0' },
    );
    markEnded(live.bus, 'done', { reason: 'completed' });
    const text = await replay.text();
    expect(text).toContain('cursor-gap');
    expect(text).toContain('after-command');
  });

  it.each(['messages', 'continue'])('leaves a warm worker in charge of the mode transition on /%s', async (endpoint) => {
    const h = setup(new RecentMessageKeys(), {
      pendingTransition: {
        sessionId: SESSION_ID,
        fromAgent: 'explore',
        toAgent: 'plan',
        updatedAt: '2026-07-23T00:00:00.000Z',
      },
    });

    const previousBus = createBus(new AbortController());
    markEnded(previousBus, 'done', { reason: 'completed' });
    h.activeRuns.set(SESSION_ID, previousBus);
    const consume = vi.spyOn(h.deps.sessionStore, 'consumePendingAgentTransition')
      .mockRejectedValue(Object.assign(new Error('writer belongs to the warm worker'), { name: 'SessionLeaseHeldError' }));
    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/${endpoint}`, {
      content: 'write the plan',
      client_msg_id: 'transition-turn-1',
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(consume).not.toHaveBeenCalled();
    expect(h.appendCalls).toEqual([]);
    expect(h.inputCalls).toEqual([]);
  });

  it('starts a fresh normal runner while structural indexing continues in the background', async () => {
    const gate = vi.fn(() => new Promise<{
      status: 'ready';
      phase: 'structural_ready';
    }>(() => {}));
    const h = setup(new RecentMessageKeys(), { projectFresh: true, ensureStructuralReady: gate });

    const response = await h.post(
      `/api/coder/sessions/${SESSION_ID}/messages`,
      { content: 'inspect project' },
    );
    expect(response.status).toBe(200);
    expect(h.ensureFresh).toHaveBeenCalledWith(99, 'session');
    expect(gate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
  });

  it('a retry with the same client_msg_id does not re-append into a live run', async () => {
    const h = setup();
    const live = seedLiveRun(h.activeRuns, SESSION_ID);

    const r1 = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, { content: 'hi', client_msg_id: 'K1' });
    expect(r1.status).toBe(200);
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.pushUserMessage).toHaveBeenCalledTimes(1);
    expect(poolMock.pushUserMessage).toHaveBeenCalledWith(
      SESSION_ID,
      'hi',
      undefined,
      expect.stringMatching(/^message-command:/),
    );
    expect(live.pushCalls).toEqual(['hi']);
    expect(live.pushExtras).toEqual([{ selectedSkillIds: undefined, roundMessageId: 42 }]);

    // Retry (connection dropped, ReconnectingSSEClient re-POSTs the same body).
    const r2 = await h.post(
      `/api/coder/sessions/${SESSION_ID}/messages`,
      { content: 'hi', client_msg_id: 'K1' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    expect(h.appendCalls).toHaveLength(0); // HTTP host never owns active-run persistence
    expect(poolMock.pushUserMessage).toHaveBeenCalledTimes(1); // NOT re-persisted or re-pushed
    expect(live.pushCalls).toEqual(['hi']); // NOT re-pushed

    markEnded(live.bus, 'done', {});
  });

  it('a retry does not spawn a second run once the original bus has ended', async () => {
    const h = setup();

    const r1 = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, { content: 'go', client_msg_id: 'K2' });
    expect(r1.status).toBe(200);
    // The worker-pool start is asynchronous — wait for it to reach the call.
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));

    const bus = h.activeRuns.get(SESSION_ID)!;
    markEnded(bus, 'done', {}); // run finished; bus lingers

    const r2 = await h.post(
      `/api/coder/sessions/${SESSION_ID}/messages`,
      { content: 'go', client_msg_id: 'K2' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // let any (unexpected) 2nd IIFE run
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1); // still one run
  });

  it('answers with a synthetic done (no side effects) when the deduped bus is gone', async () => {
    const fakeStore = {
      claim: () => ({
        kind: 'existing' as const,
        settled: Promise.resolve({ bus: undefined, sinceHint: -1 }),
      }),
      lookup: () => ({ bus: undefined, sinceHint: -1 }),
      record: () => true,
      recordTerminal: () => true,
      rejectClaim: () => {},
    };
    const h = setup(fakeStore);

    const res = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, { content: 'hi', client_msg_id: 'K3' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: done');
    expect(text).toContain('"duplicate":true');
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.runFresh).not.toHaveBeenCalled();
    expect(h.acceptCalls).toHaveLength(0);
  });

  it('a retry with a recorded key replays instead of raising the spurious 409 (and preserves 409 otherwise)', async () => {
    const h = setup();
    const live = seedLiveRun(h.activeRuns, SESSION_ID);

    // Original send lands while the runner is idle → attaches + records the key.
    await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, { content: 'hi', client_msg_id: 'K4' });
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.pushUserMessage).toHaveBeenCalledTimes(1);

    // Runner is now blocked on an interactive tool.
    live.state.waiting = true;

    // Retry of the SAME send → deduped to a replay, never hits the 409 check.
    const retry = await h.post(
      `/api/coder/sessions/${SESSION_ID}/messages`,
      { content: 'hi', client_msg_id: 'K4' },
      { 'Last-Event-ID': '0' },
    );
    expect(retry.status).toBe(200);
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.pushUserMessage).toHaveBeenCalledTimes(1);

    // A genuinely new send while waiting still gets the 409 handshake.
    const fresh = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, { content: 'other', client_msg_id: 'K5' });
    expect(fresh.status).toBe(409);
    expect(await fresh.json()).toMatchObject({ code: 'INTERACTION_PENDING' });

    markEnded(live.bus, 'done', {});
  });

  it('allows a retired app coordinator session to switch to a supported agent', async () => {
    const h = setup(new RecentMessageKeys(), { sessionAgent: 'app_orchestrator' });

    const res = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'seguir refinando',
      agent: 'explore',
      client_msg_id: 'K6',
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(poolMock.runFresh.mock.calls[0][1]).toMatchObject({ agent: 'explore' });
  });

  it('still honors explicit agent changes for normal non-specialist sessions', async () => {
    const h = setup(new RecentMessageKeys(), { sessionAgent: 'build' });

    const res = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'investigar primeiro',
      agent: 'explore',
      client_msg_id: 'K7',
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(poolMock.runFresh.mock.calls[0][1]).toMatchObject({ agent: 'explore' });
  });

  it('resolves a custom agent into runtime prompt, skills, and tool allowlist', async () => {
    const custom = {
      id: '12345678-abcd-4321-abcd-123456789abc',
      name: 'Security reviewer',
      description: 'Reviews risky changes',
      baseAgentId: 'plan',
      prompt: 'Focus on trust boundaries.',
      skillIds: ['security-review'],
      pinnedToolNames: ['read_file'],
      requiredToolTiers: ['unity'],
      visibleToolCap: 64,
      toolNames: ['read_file', 'grep'],
      enabled: true,
      managedBy: null,
      managedVersion: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const selectionId = `custom:${custom.id}`;
    const h = setup(new RecentMessageKeys(), { sessionAgent: selectionId, customAgents: [custom] });

    const res = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'review this change',
      selected_skill_ids: ['repo-review'],
      client_msg_id: 'K8',
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(poolMock.runFresh.mock.calls[0][1]).toMatchObject({
      agent: 'plan',
      agentSelectionId: selectionId,
      customAgentPrompt: custom.prompt,
      allowedToolNames: custom.toolNames,
      initialPinnedTools: custom.pinnedToolNames,
      initialToolTiers: custom.requiredToolTiers,
      initialVisibleToolCap: custom.visibleToolCap,
      selectedSkillIds: ['security-review', 'repo-review'],
    });
  });

  it('forwards the model-facing request to the worker without reducing it', async () => {
    const h = setup(new RecentMessageKeys(), { sessionAgent: 'build' });
    const ideContext = {
      activeFile: 'src/main.ts',
      selections: [{ path: 'src/main.ts', startLine: 4, endLine: 9, text: 'const value = 1;' }],
      openTabs: ['src/main.ts', 'src/app.ts'],
    };

    const res = await h.post(`/api/coder/sessions/${SESSION_ID}/messages`, {
      content: 'implement the change',
      max_turns: 17,
      plan_mode: false,
      agent: 'build',
      profile: 'full',
      worktree: { name: 'worker-isolation', branch: 'codex/worker-isolation' },
      thinking: true,
      describe_images: true,
      selected_skill_ids: ['repo-review'],
      ide_context: ideContext,
      client_msg_id: 'K9',
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(poolMock.runFresh).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({
      userMessage: 'implement the change',
      maxTurns: 17,
      planMode: false,
      agent: 'build',
      profile: 'full',
      worktree: { name: 'worker-isolation', branch: 'codex/worker-isolation' },
      thinking: true,
      describeImages: true,
      selectedSkillIds: ['repo-review'],
      ideContext,
    }));
  });
});

describe('POST /continue idempotency + live-run hardening', () => {
  it('attaches to a live run instead of spawning a second runner (no key)', async () => {
    const h = setup();
    const live = seedLiveRun(h.activeRuns, SESSION_ID);

    const res = await h.post(`/api/coder/sessions/${SESSION_ID}/continue`, {});
    expect(res.status).toBe(200);
    expect(poolMock.runFresh).not.toHaveBeenCalled(); // tailed the live run, no second worker run

    markEnded(live.bus, 'done', {});
  });

  it('a retry with the same client_msg_id does not start a second run', async () => {
    const h = setup();

    const r1 = await h.post(`/api/coder/sessions/${SESSION_ID}/continue`, { client_msg_id: 'C1' });
    expect(r1.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));

    const bus = h.activeRuns.get(SESSION_ID)!;
    markEnded(bus, 'done', {});

    const r2 = await h.post(
      `/api/coder/sessions/${SESSION_ID}/continue`,
      { client_msg_id: 'C1' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1);
  });

  it('continues a retired app coordinator session with the requested supported agent', async () => {
    const h = setup(new RecentMessageKeys(), { sessionAgent: 'app_orchestrator' });

    const res = await h.post(`/api/coder/sessions/${SESSION_ID}/continue`, {
      agent: 'explore',
      client_msg_id: 'C2',
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(poolMock.runFresh.mock.calls[0][1]).toMatchObject({ agent: 'explore', resume: true });
  });
});


describe('worker recovery on the same conversation', () => {
  it('replays the pre-write refusal if a live turn finishes before a follow-up reaches its worker', async () => {
    const h = setup();
    const { bus } = seedLiveRun(h.activeRuns, SESSION_ID);
    poolMock.pushUserMessage.mockImplementationOnce(async () => {
      markEnded(bus, 'done', { reason: 'completed' });
      throw new CoderTurnEndedError();
    });
    const url = '/api/coder/sessions/' + SESSION_ID + '/messages';
    const input = { content: 'late follow-up', client_msg_id: 'late-followup', response_mode: 'json' };
    const terminal = { event: 'error', data: { reason: 'turn-ended-before-input', not_started: true } };
    expect(await (await h.post(url, input)).json()).toMatchObject({ terminal });
    expect(await (await h.post(url, input)).json()).toMatchObject({ terminal });
    expect(poolMock.pushUserMessage).toHaveBeenCalledTimes(1);
    expect(poolMock.runFresh).not.toHaveBeenCalled();
  });

  it('shows a finished conversation as idle while its worker is still warm', async () => {
    const h = setup();
    const { bus } = seedLiveRun(h.runtime.activeRuns, SESSION_ID);
    const state = async () => (await h.app.request('/api/coder/sessions/' + SESSION_ID + '/state')).json();
    expect(await state()).toHaveProperty('alive', true);
    markEnded(bus, 'done', { reason: 'completed' });
    expect(h.runtime.activeRuns.has(SESSION_ID)).toBe(true);
    expect(await state()).toHaveProperty('alive', false);
  });

  it.each([
    ['messages', 'worker-draining'], ['continue', 'worker-draining'],
    ['messages', 'worker-unavailable-before-input'], ['continue', 'worker-unavailable-before-input'],
  ])('replays a proven pre-start refusal on %s (%s) and accepts the next command', async (path, reason) => {
    const h = setup();
    const url = '/api/coder/sessions/' + SESSION_ID + '/' + path;
    const body = { content: 'same message', client_msg_id: 'first-command', response_mode: 'json' };
    const failure = reason === 'worker-draining' ? new CoderWorkerDrainError(new Error('lost drain acknowledgement'))
      : new CoderWorkerBootError(new Error('thread exited before ready'));
    poolMock.runFresh.mockRejectedValueOnce(failure);
    async function expectRefusal(response: Response) {
      expect(response.status).toBe(200);
      if (path === 'messages') {
        expect(await response.json()).toMatchObject({ terminal: { event: 'error', data: {
          reason, not_started: true, message: expect.stringContaining('worker'),
        } } });
      } else {
        const stream = await response.text();
        expect(stream).toContain('event: error');
        expect(stream).toContain(JSON.stringify(reason));
        expect(stream).toContain('"not_started":true');
      }
    }
    await expectRefusal(await h.post(url, body));
    await expectRefusal(await h.post(url, body));
    const restored = setup(new RecentMessageKeys(), { controlPlaneCommands: h.controlPlaneCommands });
    await expectRefusal(await restored.post(url, body));
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1);
    const next = await restored.post(url, { ...body, client_msg_id: 'new-command' });
    expect(next.status).toBe(200);
    expect(poolMock.runFresh).toHaveBeenCalledTimes(2);
    markEnded(restored.activeRuns.get(SESSION_ID)!, 'done', { reason: 'completed' });
    if (path === 'continue') expect(await next.text()).toContain('completed');
    else expect(await next.json()).toMatchObject({ started: true });
  });
});

describe('uncertain tool effect admission', () => {
  it.each(['messages', 'continue'])('keeps the original command live after unconfirmed startup cleanup on %s', async path => {
    const h = setup();
    const bus = createBus(new AbortController());
    poolMock.runFresh.mockImplementationOnce(async () => {
      workerEntries.set(SESSION_ID, bus);
      throw Object.assign(new Error('Cleanup unconfirmed'), { code: 'CODER_STARTUP_UNCERTAIN' });
    });
    const body = { content: 'continue', client_msg_id: 'uncertain-start' };
    const response = await h.post(`/api/coder/sessions/${SESSION_ID}/${path}`, body);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'CODER_STARTUP_UNCERTAIN', retryable: false });
    expect([...h.controlPlaneCommands.values()].map(command => command.status)).toEqual(['accepted']);
    const retry = await h.post(`/api/coder/sessions/${SESSION_ID}/${path}`, body);
    expect(retry.status).toBe(200);
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1);
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
    markEnded(bus, 'error', { reason: 'original-attempt-reconciled' });
    expect(await retry.text()).toContain('original-attempt-reconciled');
  });

  it('admits explicit continue so bootstrap can restore recovery restrictions from durable evidence', async () => {
    const h = setup(new RecentMessageKeys(), { unresolvedToolOutcome: true });
    const response = await h.post('/api/coder/sessions/' + SESSION_ID + '/continue', {});
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(poolMock.runFresh.mock.calls[0][1]).toMatchObject({ resume: true });
    expect(h.acceptCalls).toHaveLength(1);
  });

  it.each(['messages', 'continue'])('preserves a typed uncertain-effect worker failure on %s', async path => {
    const h = setup();
    poolMock.runFresh.mockRejectedValueOnce(Object.assign(new Error('Uncertain effect'), { code: 'TOOL_OUTCOME_UNKNOWN' }));
    const response = await h.post('/api/coder/sessions/' + SESSION_ID + '/' + path, { content: 'continue' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'Uncertain effect', code: 'TOOL_OUTCOME_UNKNOWN', retryable: false });
  });
});
