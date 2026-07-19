/**
 * Route-level idempotency tests for POST /messages and POST /continue.
 *
 * A `ReconnectingSSEClient` retry re-POSTs the body (with a stable
 * `client_msg_id`). These tests assert the retry is deduped into a bus replay
 * instead of re-running the append/push/spawn side effects, and that the
 * /continue live-run hardening never spins a second concurrent runner.
 *
 * The route is mounted against fake deps/runtime (no DB, no real worker). The
 * mandatory worker pool is mocked at its route-facing RPC boundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const { poolMock, workerEntries } = vi.hoisted(() => ({
  workerEntries: new Map<number, unknown>(),
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

vi.mock('@mcp/app-studio/local-db.js', () => ({ findLocalD1File: () => null }));

import { mountCoderStreamRoutes } from '../stream.js';
import { createBus, markEnded, type CoderRunBus } from '../../../../coder-bus.js';
import { RecentMessageKeys } from '../../recent-message-keys.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

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

const runners = new Map<number, ReturnType<typeof makeRunner>>();

function setup(
  recentMessageKeys: Pick<RecentMessageKeys, 'lookup' | 'record'> = new RecentMessageKeys(),
  opts: {
    sessionAgent?: string | null;
    customAgents?: unknown[];
    globalFresh?: boolean;
    projectFresh?: boolean;
    ensureStructuralReady?: () => Promise<{
      status: 'ready' | 'aborted' | 'disabled' | 'timeout' | 'error' | 'too_large';
      phase: 'none' | 'scanning' | 'structural_indexing' | 'structural_ready' | 'semantic_indexing' | 'semantic_ready' | 'too_large' | 'error';
      error?: string;
    }>;
  } = {},
) {
  const appendCalls: unknown[] = [];
  const projectId = opts.globalFresh || opts.projectFresh ? 99 : null;
  const sessionStore = {
    getSession: (id: number) => ({
      id,
      project_id: projectId,
      status: 'idle',
      agent: opts.sessionAgent ?? null,
      is_global: !!opts.globalFresh,
      compaction_summary: null,
    }),
    getMessageCount: () => projectId != null ? appendCalls.length : 1,
    appendMessage: (_id: number, msg: unknown) => { appendCalls.push(msg); return appendCalls.length; },
    loadSessionWithMessages: (id: number) => ({
      session: { id, project_id: projectId, agent: opts.sessionAgent ?? null },
      messages: [{ role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1' }] }],
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
    db: { getProject: () => projectId == null ? null : ({ id: projectId, root_path: 'D:/fake' }) },
    projectIndexService: {
      ensureFresh: () => {},
      ensureStructuralReady: opts.ensureStructuralReady ?? (async () => ({
        status: 'ready' as const,
        phase: 'structural_ready' as const,
      })),
    },
    semanticCoordinator: {
      acquireCodeProjectLease: () => () => {},
    },
    taskPreflight: {
      run: async () => ({ status: 'unconfigured' }),
      generateSessionTitle: async () => ({ status: 'unconfigured' }),
    },
    buildAgentDecisionRuntimeOptions: () => ({}),
    buildToolSelectionFilter: () => undefined,
  } as unknown as ServerDeps;

  const runtime = {
    activeRuns: new Map<number, CoderRunBus>(),
    findPendingInteraction: () => null,
    findDanglingToolUse: () => null,
    coderPipelineRegistry: {},
    recentMessageKeys,
  } as unknown as CoderRuntime;

  const app = new Hono();
  mountCoderStreamRoutes(app, deps, runtime);

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  return { app, deps, runtime, activeRuns: workerEntries as Map<number, CoderRunBus>, appendCalls, post };
}

/** Seed a live worker run and its mocked control surface. */
function seedLiveRun(activeRuns: Map<number, CoderRunBus>, id: number) {
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
  poolMock.getBus.mockImplementation((id: number) => workerEntries.get(id) ?? null);
  poolMock.runFresh.mockImplementation(async (id: number) => {
    const bus = createBus(new AbortController());
    workerEntries.set(id, bus);
    return bus;
  });
  poolMock.isWaitingForInput.mockImplementation(async (id: number) => runners.get(id)?.state.waiting ?? false);
  poolMock.interruptWait.mockImplementation(async (id: number) => {
    const runner = runners.get(id);
    if (runner) runner.state.waiting = false;
  });
  poolMock.pushUserMessage.mockImplementation(async (
    id: number,
    content: string,
    selectedSkillIds?: string[],
    roundMessageId?: number,
  ) => {
    runners.get(id)?.runner.pushUserMessage(content, { selectedSkillIds, roundMessageId });
  });
  vi.stubEnv('CODER_PREFLIGHT', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /messages idempotency', () => {
  it('does not start a fresh normal runner before structural indexing is ready', async () => {
    let release!: (value: { status: 'ready'; phase: 'structural_ready' }) => void;
    const gate = vi.fn(() => new Promise<{ status: 'ready'; phase: 'structural_ready' }>((resolve) => {
      release = resolve;
    }));
    const h = setup(new RecentMessageKeys(), { projectFresh: true, ensureStructuralReady: gate });

    const pending = h.post('/api/coder/sessions/1/messages', { content: 'inspect project' });
    await vi.waitFor(() => expect(gate).toHaveBeenCalledTimes(1));
    expect(poolMock.runFresh).not.toHaveBeenCalled();

    release({ status: 'ready', phase: 'structural_ready' });
    const response = await pending;
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
  });

  it('starts the same session in degraded mode when the structural gate times out', async () => {
    const h = setup(new RecentMessageKeys(), {
      projectFresh: true,
      ensureStructuralReady: async () => ({ status: 'timeout', phase: 'scanning' }),
    });

    const response = await h.post('/api/coder/sessions/1/messages', { content: 'inspect project' });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
  });

  it('a retry with the same client_msg_id does not re-append into a live run', async () => {
    const h = setup();
    const live = seedLiveRun(h.activeRuns, 1);

    const r1 = await h.post('/api/coder/sessions/1/messages', { content: 'hi', client_msg_id: 'K1' });
    expect(r1.status).toBe(200);
    expect(h.appendCalls).toHaveLength(1);
    expect(live.pushCalls).toEqual(['hi']);
    expect(live.pushExtras).toEqual([{ selectedSkillIds: undefined, roundMessageId: 1 }]);

    // Retry (connection dropped, ReconnectingSSEClient re-POSTs the same body).
    const r2 = await h.post(
      '/api/coder/sessions/1/messages',
      { content: 'hi', client_msg_id: 'K1' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    expect(h.appendCalls).toHaveLength(1); // NOT re-appended
    expect(live.pushCalls).toEqual(['hi']); // NOT re-pushed

    markEnded(live.bus, 'done', {});
  });

  it('a retry does not spawn a second run once the original bus has ended', async () => {
    const h = setup();

    const r1 = await h.post('/api/coder/sessions/1/messages', { content: 'go', client_msg_id: 'K2' });
    expect(r1.status).toBe(200);
    // The worker-pool start is asynchronous — wait for it to reach the call.
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));

    const bus = h.activeRuns.get(1)!;
    markEnded(bus, 'done', {}); // run finished; bus lingers

    const r2 = await h.post(
      '/api/coder/sessions/1/messages',
      { content: 'go', client_msg_id: 'K2' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // let any (unexpected) 2nd IIFE run
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1); // still one run
  });

  it('answers with a synthetic done (no side effects) when the deduped bus is gone', async () => {
    const fakeStore = {
      lookup: () => ({ bus: undefined, sinceHint: -1 }),
      record: () => {},
    };
    const h = setup(fakeStore);

    const res = await h.post('/api/coder/sessions/1/messages', { content: 'hi', client_msg_id: 'K3' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: done');
    expect(text).toContain('"duplicate":true');
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.runFresh).not.toHaveBeenCalled();
  });

  it('a retry with a recorded key replays instead of raising the spurious 409 (and preserves 409 otherwise)', async () => {
    const h = setup();
    const live = seedLiveRun(h.activeRuns, 1);

    // Original send lands while the runner is idle → attaches + records the key.
    await h.post('/api/coder/sessions/1/messages', { content: 'hi', client_msg_id: 'K4' });
    expect(h.appendCalls).toHaveLength(1);

    // Runner is now blocked on an interactive tool.
    live.state.waiting = true;

    // Retry of the SAME send → deduped to a replay, never hits the 409 check.
    const retry = await h.post(
      '/api/coder/sessions/1/messages',
      { content: 'hi', client_msg_id: 'K4' },
      { 'Last-Event-ID': '0' },
    );
    expect(retry.status).toBe(200);
    expect(h.appendCalls).toHaveLength(1);

    // A genuinely new send while waiting still gets the 409 handshake.
    const fresh = await h.post('/api/coder/sessions/1/messages', { content: 'other', client_msg_id: 'K5' });
    expect(fresh.status).toBe(409);
    expect(await fresh.json()).toMatchObject({ code: 'INTERACTION_PENDING' });

    markEnded(live.bus, 'done', {});
  });

  it('keeps a persisted app coordinator even if the POST carries a stale agent', async () => {
    const h = setup(new RecentMessageKeys(), { sessionAgent: 'app_orchestrator' });

    const res = await h.post('/api/coder/sessions/1/messages', {
      content: 'seguir refinando',
      agent: 'explore',
      client_msg_id: 'K6',
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(poolMock.runFresh.mock.calls[0][1]).toMatchObject({ agent: 'app_orchestrator' });
  });

  it('still honors explicit agent changes for normal non-specialist sessions', async () => {
    const h = setup(new RecentMessageKeys(), { sessionAgent: 'build' });

    const res = await h.post('/api/coder/sessions/1/messages', {
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
      toolNames: ['read_file', 'grep'],
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const selectionId = `custom:${custom.id}`;
    const h = setup(new RecentMessageKeys(), { sessionAgent: selectionId, customAgents: [custom] });

    const res = await h.post('/api/coder/sessions/1/messages', {
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

    const res = await h.post('/api/coder/sessions/1/messages', {
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
    expect(poolMock.runFresh).toHaveBeenCalledWith(1, expect.objectContaining({
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
    const live = seedLiveRun(h.activeRuns, 1);

    const res = await h.post('/api/coder/sessions/1/continue', {});
    expect(res.status).toBe(200);
    expect(poolMock.runFresh).not.toHaveBeenCalled(); // tailed the live run, no second worker run

    markEnded(live.bus, 'done', {});
  });

  it('a retry with the same client_msg_id does not start a second run', async () => {
    const h = setup();

    const r1 = await h.post('/api/coder/sessions/1/continue', { client_msg_id: 'C1' });
    expect(r1.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));

    const bus = h.activeRuns.get(1)!;
    markEnded(bus, 'done', {});

    const r2 = await h.post(
      '/api/coder/sessions/1/continue',
      { client_msg_id: 'C1' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(poolMock.runFresh).toHaveBeenCalledTimes(1);
  });

  it('keeps a persisted app coordinator during continue', async () => {
    const h = setup(new RecentMessageKeys(), { sessionAgent: 'app_orchestrator' });

    const res = await h.post('/api/coder/sessions/1/continue', {
      agent: 'explore',
      client_msg_id: 'C2',
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(poolMock.runFresh).toHaveBeenCalledTimes(1));
    expect(poolMock.runFresh.mock.calls[0][1]).toMatchObject({ agent: 'app_orchestrator', resume: true });
  });
});
