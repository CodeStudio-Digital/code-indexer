/**
 * Route-level idempotency tests for POST /messages and POST /continue.
 *
 * A `ReconnectingSSEClient` retry re-POSTs the body (with a stable
 * `client_msg_id`). These tests assert the retry is deduped into a bus replay
 * instead of re-running the append/push/spawn side effects, and that the
 * /continue live-run hardening never spins a second concurrent runner.
 *
 * The route is mounted against fake deps/runtime (no DB, no worker). `runCoder`
 * and the docs/preview side-effect modules are mocked so importing `stream.ts`
 * doesn't drag in the real agent runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const { runCoderMock } = vi.hoisted(() => ({ runCoderMock: vi.fn() }));

vi.mock('@mcp/docs-agent/bridges/docs-bridge.js', () => ({ installDocsDeepResearch: () => false }));
// listEnabledPluginRuntime opens a SQLite store (better-sqlite3) — stub it so
// the fresh-run IIFE reaches runCoder in the test env. Everything else real.
vi.mock('@mcp/plugin-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/plugin-host')>();
  return { ...actual, listEnabledPluginRuntime: () => ({ toolPlugins: [], bundles: [] }) };
});
vi.mock('../../../../sse/closeCoderPreview.js', () => ({
  closePreviewWindow: () => {},
  closePreviewSession: () => {},
}));
vi.mock('../../../../sse/builder-checkpoint.js', () => ({ notifyBuilderRunEnded: () => {} }));
vi.mock('@mcp/code-agent/index.js', () => ({ runCoder: runCoderMock }));
vi.mock('@mcp/app-studio/local-db.js', () => ({ findLocalD1File: () => null }));

import { mountCoderStreamRoutes } from '../stream.js';
import { createBus, markEnded, setBusRunner, type CoderRunBus } from '../../../../coder-bus.js';
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

function setup(
  recentMessageKeys: Pick<RecentMessageKeys, 'lookup' | 'record'> = new RecentMessageKeys(),
  opts: {
    sessionAgent?: string | null;
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
    providerStore: { getProvider: () => undefined, listModels: () => [] },
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

  const activeRuns = new Map<number, CoderRunBus>();
  const runtime = {
    activeRuns,
    BUS_LINGER_MS: 50,
    wireRunnerToBus: () => {},
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

  return { app, deps, runtime, activeRuns, appendCalls, post };
}

/** Seed a live run whose runner is wired (resolves runnerReady). */
function seedLiveRun(activeRuns: Map<number, CoderRunBus>, id: number) {
  const bus = createBus(new AbortController());
  const r = makeRunner();
  setBusRunner(bus, r.runner as never);
  activeRuns.set(id, bus);
  return { bus, ...r };
}

beforeEach(() => {
  runCoderMock.mockReset();
  runCoderMock.mockImplementation(async () => ({
    runner: { isWaitingForInput: () => false },
    session: { id: 1 },
    indexStatus: {},
    done: Promise.resolve(),
  }));
  vi.stubEnv('MCP_CODER_WORKER', '');
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
    expect(runCoderMock).not.toHaveBeenCalled();

    release({ status: 'ready', phase: 'structural_ready' });
    const response = await pending;
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(runCoderMock).toHaveBeenCalledTimes(1));
  });

  it('starts the same session in degraded mode when the structural gate times out', async () => {
    const h = setup(new RecentMessageKeys(), {
      projectFresh: true,
      ensureStructuralReady: async () => ({ status: 'timeout', phase: 'scanning' }),
    });

    const response = await h.post('/api/coder/sessions/1/messages', { content: 'inspect project' });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(runCoderMock).toHaveBeenCalledTimes(1));
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
    // runCoder fires in a detached async IIFE — wait for it to reach the call.
    await vi.waitFor(() => expect(runCoderMock).toHaveBeenCalledTimes(1));

    const bus = h.activeRuns.get(1)!;
    markEnded(bus, 'done', {}); // run finished; bus lingers

    const r2 = await h.post(
      '/api/coder/sessions/1/messages',
      { content: 'go', client_msg_id: 'K2' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // let any (unexpected) 2nd IIFE run
    expect(runCoderMock).toHaveBeenCalledTimes(1); // still one run
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
    expect(runCoderMock).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(runCoderMock).toHaveBeenCalledTimes(1));
    expect(runCoderMock.mock.calls[0][0]).toMatchObject({ agent: 'app_orchestrator' });
  });

  it('still honors explicit agent changes for normal non-specialist sessions', async () => {
    const h = setup(new RecentMessageKeys(), { sessionAgent: 'build' });

    const res = await h.post('/api/coder/sessions/1/messages', {
      content: 'investigar primeiro',
      agent: 'explore',
      client_msg_id: 'K7',
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(runCoderMock).toHaveBeenCalledTimes(1));
    expect(runCoderMock.mock.calls[0][0]).toMatchObject({ agent: 'explore' });
  });
});

describe('POST /continue idempotency + live-run hardening', () => {
  it('attaches to a live run instead of spawning a second runner (no key)', async () => {
    const h = setup();
    const live = seedLiveRun(h.activeRuns, 1);

    const res = await h.post('/api/coder/sessions/1/continue', {});
    expect(res.status).toBe(200);
    expect(runCoderMock).not.toHaveBeenCalled(); // tailed the live run, no 2nd runCoder

    markEnded(live.bus, 'done', {});
  });

  it('a retry with the same client_msg_id does not start a second run', async () => {
    const h = setup();

    const r1 = await h.post('/api/coder/sessions/1/continue', { client_msg_id: 'C1' });
    expect(r1.status).toBe(200);
    await vi.waitFor(() => expect(runCoderMock).toHaveBeenCalledTimes(1));

    const bus = h.activeRuns.get(1)!;
    markEnded(bus, 'done', {});

    const r2 = await h.post(
      '/api/coder/sessions/1/continue',
      { client_msg_id: 'C1' },
      { 'Last-Event-ID': '0' },
    );
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(runCoderMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a persisted app coordinator during continue', async () => {
    const h = setup(new RecentMessageKeys(), { sessionAgent: 'app_orchestrator' });

    const res = await h.post('/api/coder/sessions/1/continue', {
      agent: 'explore',
      client_msg_id: 'C2',
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(runCoderMock).toHaveBeenCalledTimes(1));
    expect(runCoderMock.mock.calls[0][0]).toMatchObject({ agent: 'app_orchestrator', resume: true });
  });
});
