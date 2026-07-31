import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
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

const SESSION_ID = asSessionId('99999999-9999-4999-8999-999999999999');

interface SelectedModel {
  provider: string;
  model: string;
}

function setup(options: {
  persisted?: SelectedModel | null;
  catalog?: SelectedModel | null;
  disabledProviders?: string[];
} = {}) {
  const persisted = options.persisted === undefined
    ? { provider: 'zai', model: 'glm-5.2' }
    : options.persisted;
  const catalog = options.catalog === undefined
    ? { provider: 'openai', model: 'gpt-fallback' }
    : options.catalog;
  const disabledProviders = new Set(options.disabledProviders ?? []);
  const createSession = vi.fn((input: Record<string, unknown>) => ({
    id: SESSION_ID,
    ...input,
  }));
  const getLastUsedProviderModel = vi.fn(() => catalog);
  const sessionStore = {
    getLastUsedProviderModel,
    createSession,
    getSession: (id: SessionId) => id === SESSION_ID ? createSession.mock.results.at(-1)?.value : null,
    listRecentSessionsGlobal: () => [],
    setSessionExecutionMode: vi.fn(),
    setSessionReasoningEffort: vi.fn(),
  };
  const providerStore = {
    getProvider: (id: string) => ({
      id,
      enabled: disabledProviders.has(id) ? 0 : 1,
    }),
    listModels: (id: string) => {
      if (id === 'zai') {
        return [{ model_id: 'glm-5.2', mode: '', enabled: 1 }];
      }
      return [{ model_id: 'gpt-fallback', mode: '', enabled: 1 }];
    },
  };
  const coderPreferences = {
    getLastSelectedModel: vi.fn(async () => persisted),
    setLastSelectedModel: vi.fn(async () => undefined),
  };
  const deps = {
    sessionStore,
    providerStore,
    coderPreferences,
    db: { getProject: () => ({ id: 7, builder_json: null }) },
  } as unknown as ServerDeps;
  const app = new Hono();
  mountCoderSessionsRoutes(app, deps, { activeRuns: new Map() } as unknown as CoderRuntime);
  return {
    app,
    createSession,
    coderPreferences,
    getLastUsedProviderModel,
  };
}

describe('coder POST /sessions last model preference', () => {
  it('creates immediately with the most recently used enabled provider/model', async () => {
    const {
      app,
      createSession,
      coderPreferences,
      getLastUsedProviderModel,
    } = setup();
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
    expect(getLastUsedProviderModel).not.toHaveBeenCalled();
    expect(coderPreferences.setLastSelectedModel).toHaveBeenCalledWith(
      'zai',
      'glm-5.2',
    );
  });

  it('falls back to the filesystem catalog when the file selection is disabled', async () => {
    const {
      app,
      createSession,
      coderPreferences,
      getLastUsedProviderModel,
    } = setup({
      persisted: { provider: 'zai', model: 'glm-5.2' },
      catalog: { provider: 'openai', model: 'gpt-fallback' },
      disabledProviders: ['zai'],
    });
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
    expect(getLastUsedProviderModel).toHaveBeenCalledOnce();
    expect(coderPreferences.setLastSelectedModel).toHaveBeenCalledWith(
      'openai',
      'gpt-fallback',
    );
  });

  it('falls back to the caller when neither file nor catalog selection is usable', async () => {
    const { app, createSession } = setup({
      persisted: { provider: 'zai', model: 'glm-5.2' },
      catalog: { provider: 'zai', model: 'glm-5.2' },
      disabledProviders: ['zai'],
    });
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
