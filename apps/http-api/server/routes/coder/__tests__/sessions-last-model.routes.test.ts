import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountCoderSessionsRoutes } from '../sessions.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    isRunning: () => false,
    getBus: () => null,
  }),
}));

function setup(lastProviderEnabled = true) {
  const createSession = vi.fn((input: Record<string, unknown>) => ({
    id: 41,
    ...input,
  }));
  const sessionStore = {
    getLastUsedProviderModel: () => ({ provider: 'zai', model: 'glm-5.2' }),
    createSession,
    getSession: (id: number) => id === 41 ? createSession.mock.results.at(-1)?.value : null,
    listRecentSessionsGlobal: () => [],
    setSessionExecutionMode: vi.fn(),
    setSessionReasoningEffort: vi.fn(),
  };
  const providerStore = {
    getProvider: (id: string) => id === 'zai' ? { id, enabled: lastProviderEnabled ? 1 : 0 } : { id, enabled: 1 },
    listModels: (id: string) => id === 'zai'
      ? [{ model_id: 'glm-5.2', mode: '', enabled: 1 }]
      : [{ model_id: 'gpt-fallback', mode: '', enabled: 1 }],
  };
  const deps = {
    sessionStore,
    providerStore,
    db: { getProject: () => ({ id: 7, builder_json: null }) },
  } as unknown as ServerDeps;
  const app = new Hono();
  mountCoderSessionsRoutes(app, deps, { activeRuns: new Map() } as unknown as CoderRuntime);
  return { app, createSession };
}

describe('coder POST /sessions last model preference', () => {
  it('creates immediately with the most recently used enabled provider/model', async () => {
    const { app, createSession } = setup();
    const response = await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 7,
        title: 'Nova sessão',
        provider: 'openai',
        model: 'gpt-fallback',
        use_last_model: true,
      }),
    });

    expect(response.status).toBe(201);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'zai',
      model: 'glm-5.2',
      title: 'Nova sessão',
    }));
  });

  it('falls back to the caller selection when the previous provider is disabled', async () => {
    const { app, createSession } = setup(false);
    const response = await app.request('/api/coder/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 7,
        title: 'Nova sessão',
        provider: 'openai',
        model: 'gpt-fallback',
        use_last_model: true,
      }),
    });

    expect(response.status).toBe(201);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-fallback',
    }));
  });
});
