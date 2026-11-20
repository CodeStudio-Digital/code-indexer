import { describe, expect, it, vi } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import { mountCoderSessionsRoutes } from '../sessions.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

const SESSION_ID = asSessionId('33333333-3333-4333-8333-333333333333');

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    isRunning: vi.fn(() => false),
  }),
}));

function setup(initialTitle = 'Nova sessão') {
  const session = { id: SESSION_ID, title: initialTitle };
  const generateSessionTitle = vi.fn(async () => ({
    status: 'ok' as const,
    title: 'Corrigir autenticação quebrada',
    latencyMs: 5,
  }));
  const setSessionTitle = vi.fn((_id: SessionId, title: string) => {
    session.title = title;
  });
  const sessionStore = {
    loadSessionWithMessages: (id: SessionId) => id === SESSION_ID ? { session, messages: [], message_rows: [] } : null,
    getSession: (id: SessionId) => id === SESSION_ID ? session : null,
    setSessionTitle,
  };
  const app = new HttpRouter();
  mountCoderSessionsRoutes(app, {
    sessionStore,
    providerStore: {},
    taskPreflight: { generateSessionTitle },
  } as unknown as ServerDeps, { activeRuns: new Map() } as unknown as CoderRuntime);
  return { app, generateSessionTitle, setSessionTitle };
}

describe('coder POST /sessions/:id/generate-title', () => {
  it('generates through the pipeline model and persists the clean result', async () => {
    const { app, generateSessionTitle, setSessionTitle } = setup();
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/generate-title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Corrija o erro de autenticação' }),
    });

    expect(response.status).toBe(200);
    expect(generateSessionTitle).toHaveBeenCalledWith({ userMessage: 'Corrija o erro de autenticação' });
    expect(setSessionTitle).toHaveBeenCalledWith(SESSION_ID, 'Corrigir autenticação quebrada');
    expect(await response.json()).toEqual({
      title: 'Corrigir autenticação quebrada',
      generated: true,
    });
  });

  it('never overwrites an existing generated or manually assigned title', async () => {
    const { app, generateSessionTitle, setSessionTitle } = setup('Login OAuth no PHP');
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/generate-title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'qualquer coisa' }),
    });

    expect(response.status).toBe(200);
    expect(generateSessionTitle).not.toHaveBeenCalled();
    expect(setSessionTitle).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ title: 'Login OAuth no PHP', generated: false });
  });
});
