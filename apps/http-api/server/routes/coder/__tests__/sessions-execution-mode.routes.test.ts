import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

const globalWorkspaceMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('../global-workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../global-workspace.js')>();
  return {
    ...actual,
    createGlobalWorkspaceSession: globalWorkspaceMocks.create,
  };
});

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    isRunning: () => false,
    getBus: () => null,
  }),
}));

import { mountCoderSessionsRoutes } from '../sessions.js';

interface MutableSession {
  id: number;
  project_id: number;
  title: string;
  provider: string;
  model: string;
  is_global: boolean;
  execution_mode_override: 'standard' | 'ultra';
  reasoning_effort_override: string | null;
}

function setup() {
  let nextId = 41;
  const sessions = new Map<number, MutableSession>();
  const addSession = (input: Record<string, unknown>, isGlobal = false): MutableSession => {
    const session: MutableSession = {
      id: nextId++,
      project_id: Number(input.project_id ?? 7),
      title: String(input.title ?? 'Session'),
      provider: String(input.provider ?? 'openai'),
      model: String(input.model ?? 'gpt-test'),
      is_global: isGlobal,
      execution_mode_override: 'standard',
      reasoning_effort_override: null,
    };
    sessions.set(session.id, session);
    return session;
  };

  const setSessionExecutionMode = vi.fn((id: number, mode: 'standard' | 'ultra') => {
    const session = sessions.get(id);
    if (session) session.execution_mode_override = mode;
  });
  const setSessionReasoningEffort = vi.fn((id: number, effort: string | null) => {
    const session = sessions.get(id);
    if (session) session.reasoning_effort_override = effort;
  });
  const sessionStore = {
    getLastUsedProviderModel: () => null,
    createSession: vi.fn((input: Record<string, unknown>) => addSession(input)),
    getSession: (id: number) => sessions.get(id) ?? null,
    listRecentSessionsGlobal: () => [],
    setSessionExecutionMode,
    setSessionReasoningEffort,
  };
  const providerStore = {
    listModels: () => [{ model_id: 'gpt-test', supported_reasoning_levels: ['high'] }],
  };
  const deps = {
    sessionStore,
    providerStore,
    db: {
      getProject: (id: number) => ({
        id,
        name: `project-${id}`,
        root_path: `D:\\project-${id}`,
        is_synthetic: false,
        builder_json: null,
      }),
    },
  } as unknown as ServerDeps;
  globalWorkspaceMocks.create.mockImplementation(async (_deps, input: Record<string, unknown>) => (
    addSession({ ...input, project_id: 900 }, true)
  ));

  const app = new Hono();
  mountCoderSessionsRoutes(app, deps, { activeRuns: new Map() } as unknown as CoderRuntime);
  return { app, setSessionExecutionMode, setSessionReasoningEffort };
}

beforeEach(() => {
  globalWorkspaceMocks.create.mockReset();
});

describe('coder session execution mode routes', () => {
  it('persists explicit Ultra independently from native reasoning effort', async () => {
    const { app, setSessionExecutionMode, setSessionReasoningEffort } = setup();
    const response = await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 7,
        title: 'Ultra session',
        provider: 'openai',
        model: 'gpt-test',
        execution_mode: 'ultra',
        reasoning_effort: 'high',
      }),
    });

    expect(response.status).toBe(201);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(41, 'ultra');
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(41, 'high');
    expect(await response.json()).toEqual(expect.objectContaining({
      execution_mode_override: 'ultra',
      reasoning_effort_override: 'high',
    }));
  });

  it('converts legacy Ultra effort on normal session creation', async () => {
    const { app, setSessionExecutionMode, setSessionReasoningEffort } = setup();
    const response = await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 7,
        title: 'Legacy session',
        provider: 'openai',
        model: 'gpt-test',
        reasoning_effort: ' Ultra ',
      }),
    });

    expect(response.status).toBe(201);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(41, 'ultra');
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(41, null);
  });

  it('lets an explicit execution mode win over the legacy pseudo-effort', async () => {
    const { app, setSessionExecutionMode, setSessionReasoningEffort } = setup();
    const response = await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 7,
        title: 'Explicit Standard session',
        provider: 'openai',
        model: 'gpt-test',
        execution_mode: 'standard',
        reasoning_effort: 'ultra',
      }),
    });

    expect(response.status).toBe(201);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(41, 'standard');
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(41, null);
  });

  it('accepts Ultra for global session creation', async () => {
    const { app, setSessionExecutionMode, setSessionReasoningEffort } = setup();
    const response = await app.request('/api/coder/sessions/global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Global Ultra',
        provider: 'openai',
        model: 'gpt-test',
        project_ids: [7, 8],
        execution_mode: 'ultra',
      }),
    });

    expect(response.status).toBe(201);
    expect(globalWorkspaceMocks.create).toHaveBeenCalledOnce();
    expect(setSessionExecutionMode).toHaveBeenCalledWith(41, 'ultra');
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(41, null);
  });

  it('converts legacy Ultra effort on global session creation', async () => {
    const { app, setSessionExecutionMode, setSessionReasoningEffort } = setup();
    const response = await app.request('/api/coder/sessions/global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Legacy global Ultra',
        provider: 'openai',
        model: 'gpt-test',
        project_ids: [7],
        reasoning_effort: 'ultra',
      }),
    });

    expect(response.status).toBe(201);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(41, 'ultra');
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(41, null);
  });

  it('updates the dedicated execution mode endpoint', async () => {
    const { app, setSessionExecutionMode } = setup();
    await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 7, title: 'Session', provider: 'openai', model: 'gpt-test' }),
    });
    setSessionExecutionMode.mockClear();

    const response = await app.request('/api/coder/sessions/41/execution-mode', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'ultra' }),
    });

    expect(response.status).toBe(200);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(41, 'ultra');
    expect(await response.json()).toEqual(expect.objectContaining({ execution_mode_override: 'ultra' }));
  });

  it('maps legacy reasoning-effort PATCH to mode without persisting the literal', async () => {
    const { app, setSessionExecutionMode, setSessionReasoningEffort } = setup();
    await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 7, title: 'Session', provider: 'openai', model: 'gpt-test' }),
    });
    setSessionExecutionMode.mockClear();
    setSessionReasoningEffort.mockClear();

    const response = await app.request('/api/coder/sessions/41/reasoning-effort', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'ULTRA' }),
    });

    expect(response.status).toBe(200);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(41, 'ultra');
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(41, null);
  });

  it('lets a legacy effort-only client leave Ultra again', async () => {
    const { app, setSessionExecutionMode, setSessionReasoningEffort } = setup();
    await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 7,
        title: 'Legacy session',
        provider: 'openai',
        model: 'gpt-test',
        reasoning_effort: 'ultra',
      }),
    });
    setSessionExecutionMode.mockClear();
    setSessionReasoningEffort.mockClear();

    const response = await app.request('/api/coder/sessions/41/reasoning-effort', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'high' }),
    });

    expect(response.status).toBe(200);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(41, 'standard');
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(41, 'high');
    expect(await response.json()).toEqual(expect.objectContaining({
      execution_mode_override: 'standard',
      reasoning_effort_override: 'high',
    }));
  });

  it('rejects unknown execution modes without writing', async () => {
    const { app, setSessionExecutionMode } = setup();
    const response = await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 7,
        title: 'Invalid session',
        provider: 'openai',
        model: 'gpt-test',
        execution_mode: 'turbo',
      }),
    });

    expect(response.status).toBe(400);
    expect(setSessionExecutionMode).not.toHaveBeenCalled();
  });
});
