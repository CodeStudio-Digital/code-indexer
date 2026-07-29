import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

const SESSION_ID = asSessionId('55555555-5555-4555-8555-555555555555');

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
  id: SessionId;
  project_id: number;
  title: string;
  provider: string;
  model: string;
  is_global: boolean;
  execution_mode_override: 'standard' | 'ultra';
  reasoning_effort_override: string | null;
  thinking_enabled: boolean;
}

function setup() {
  const sessions = new Map<SessionId, MutableSession>();
  const addSession = (input: Record<string, unknown>, isGlobal = false): MutableSession => {
    const session: MutableSession = {
      id: SESSION_ID,
      project_id: Number(input.project_id ?? 7),
      title: String(input.title ?? 'Session'),
      provider: String(input.provider ?? 'openai'),
      model: String(input.model ?? 'gpt-test'),
      is_global: isGlobal,
      execution_mode_override:
        input.execution_mode_override === 'ultra' ? 'ultra' : 'standard',
      reasoning_effort_override:
        typeof input.reasoning_effort_override === 'string'
          ? input.reasoning_effort_override
          : null,
      thinking_enabled: input.thinking_enabled === true,
    };
    sessions.set(session.id, session);
    return session;
  };

  const setSessionExecutionMode = vi.fn((id: SessionId, mode: 'standard' | 'ultra') => {
    const session = sessions.get(id);
    if (session) session.execution_mode_override = mode;
  });
  const setSessionReasoningEffort = vi.fn((id: SessionId, effort: string | null) => {
    const session = sessions.get(id);
    if (session) session.reasoning_effort_override = effort;
  });
  const sessionStore = {
    getLastUsedProviderModel: () => null,
    createSession: vi.fn((input: Record<string, unknown>) => addSession(input)),
    getSession: (id: SessionId) => sessions.get(id) ?? null,
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
  return {
    app,
    createSession: sessionStore.createSession,
    setSessionExecutionMode,
    setSessionReasoningEffort,
  };
}

beforeEach(() => {
  globalWorkspaceMocks.create.mockReset();
});

describe('coder session execution mode routes', () => {
  it('persists explicit Ultra independently from native reasoning effort', async () => {
    const {
      app,
      createSession,
      setSessionExecutionMode,
      setSessionReasoningEffort,
    } = setup();
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
        thinking_enabled: true,
      }),
    });

    expect(response.status).toBe(201);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      execution_mode_override: 'ultra',
      reasoning_effort_override: 'high',
      thinking_enabled: true,
    }));
    expect(setSessionExecutionMode).not.toHaveBeenCalled();
    expect(setSessionReasoningEffort).not.toHaveBeenCalled();
    expect(await response.json()).toEqual(expect.objectContaining({
      execution_mode_override: 'ultra',
      reasoning_effort_override: 'high',
      thinking_enabled: true,
    }));
  });

  it('converts legacy Ultra effort on normal session creation', async () => {
    const {
      app,
      createSession,
      setSessionExecutionMode,
      setSessionReasoningEffort,
    } = setup();
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
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      execution_mode_override: 'ultra',
      reasoning_effort_override: null,
    }));
    expect(setSessionExecutionMode).not.toHaveBeenCalled();
    expect(setSessionReasoningEffort).not.toHaveBeenCalled();
  });

  it('lets an explicit execution mode win over the legacy pseudo-effort', async () => {
    const {
      app,
      createSession,
      setSessionExecutionMode,
      setSessionReasoningEffort,
    } = setup();
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
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      execution_mode_override: 'standard',
      reasoning_effort_override: null,
    }));
    expect(setSessionExecutionMode).not.toHaveBeenCalled();
    expect(setSessionReasoningEffort).not.toHaveBeenCalled();
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
    expect(globalWorkspaceMocks.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        execution_mode_override: 'ultra',
        reasoning_effort_override: null,
      }),
    );
    expect(setSessionExecutionMode).not.toHaveBeenCalled();
    expect(setSessionReasoningEffort).not.toHaveBeenCalled();
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
    expect(globalWorkspaceMocks.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        execution_mode_override: 'ultra',
        reasoning_effort_override: null,
      }),
    );
    expect(setSessionExecutionMode).not.toHaveBeenCalled();
    expect(setSessionReasoningEffort).not.toHaveBeenCalled();
  });

  it('updates the dedicated execution mode endpoint', async () => {
    const { app, setSessionExecutionMode } = setup();
    await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 7, title: 'Session', provider: 'openai', model: 'gpt-test' }),
    });
    setSessionExecutionMode.mockClear();

    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/execution-mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'ultra' }),
    });

    expect(response.status).toBe(200);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(SESSION_ID, 'ultra');
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

    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/reasoning-effort`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'ULTRA' }),
    });

    expect(response.status).toBe(200);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(SESSION_ID, 'ultra');
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(SESSION_ID, null);
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

    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/reasoning-effort`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'high' }),
    });

    expect(response.status).toBe(200);
    expect(setSessionExecutionMode).toHaveBeenCalledWith(SESSION_ID, 'standard');
    expect(setSessionReasoningEffort).toHaveBeenCalledWith(SESSION_ID, 'high');
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
