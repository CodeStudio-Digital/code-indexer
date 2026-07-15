import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountCoderSessionsRoutes } from '../sessions.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

function setup(initialTitle = 'Nova sessão') {
  const session = { id: 1, title: initialTitle };
  const generateSessionTitle = vi.fn(async () => ({
    status: 'ok' as const,
    title: 'Corrigir autenticação quebrada',
    latencyMs: 5,
  }));
  const setSessionTitle = vi.fn((_id: number, title: string) => {
    session.title = title;
  });
  const sessionStore = {
    loadSessionWithMessages: (id: number) => id === 1 ? { session, messages: [], message_rows: [] } : null,
    getSession: (id: number) => id === 1 ? session : null,
    setSessionTitle,
    listRecentSessionsGlobal: () => [],
  };
  const app = new Hono();
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
    const response = await app.request('/api/coder/sessions/1/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Corrija o erro de autenticação' }),
    });

    expect(response.status).toBe(200);
    expect(generateSessionTitle).toHaveBeenCalledWith({ userMessage: 'Corrija o erro de autenticação' });
    expect(setSessionTitle).toHaveBeenCalledWith(1, 'Corrigir autenticação quebrada');
    expect(await response.json()).toEqual({
      title: 'Corrigir autenticação quebrada',
      generated: true,
    });
  });

  it('never overwrites an existing generated or manually assigned title', async () => {
    const { app, generateSessionTitle, setSessionTitle } = setup('Login OAuth no PHP');
    const response = await app.request('/api/coder/sessions/1/generate-title', {
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
