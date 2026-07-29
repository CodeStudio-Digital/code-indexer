import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../apps/http-api/sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    isRunning: vi.fn(() => false),
  }),
}));

import { mountCoderSessionsRoutes } from '../../apps/http-api/server/routes/coder/sessions.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000793';

function sessionWithRows(rows: Array<{ role: string; content_json: string }> = []) {
  return {
    session: {
      id: SESSION_ID,
      project_id: 1,
      title: 'Nova sessao',
      provider: 'openai',
      model: 'gpt-4o-mini',
    },
    messages: [],
    message_rows: rows.map((row, idx) => ({
      id: `00000000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
      seq: idx + 1,
      session_id: SESSION_ID,
      role: row.role,
      content_json: row.content_json,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      created_at: '2026-05-28T00:00:00.000Z',
    })),
  };
}

function mount(data: unknown) {
  const app = new Hono();
  const session = (data as { session?: Record<string, unknown> } | null)?.session ?? null;
  const generateSessionTitle = vi.fn(
    async (_input: { userMessage: string }): Promise<{
      status: 'ok' | 'unconfigured';
      title: string | null;
      latencyMs: number;
    }> => ({
      status: 'ok',
      title: 'Generated Session Title',
      latencyMs: 1,
    }),
  );
  const sessionStore = {
    loadSessionWithMessages: vi.fn(() => data),
    getSession: vi.fn(() => session),
    setSessionTitle: vi.fn(),
  };
  mountCoderSessionsRoutes(
    app,
    {
      sessionStore,
      providerStore: {},
      taskPreflight: { generateSessionTitle },
    } as never,
    {
      activeRuns: new Map(),
    } as never,
  );
  return { app, sessionStore, generateSessionTitle };
}

async function postGenerateTitle(app: Hono, body: unknown) {
  return app.request(`/api/coder/sessions/${SESSION_ID}/generate-title`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('coder generate-title route', () => {
  it('uses the message text sent in the request body', async () => {
    const { app, sessionStore, generateSessionTitle } = mount(sessionWithRows());

    const res = await postGenerateTitle(app, {
      content: 'Bug: generate-title nao recebe o primeiro texto enviado',
    });

    expect(res.status).toBe(200);
    expect(generateSessionTitle).toHaveBeenCalledWith(
      { userMessage: 'Bug: generate-title nao recebe o primeiro texto enviado' },
    );
    expect(sessionStore.setSessionTitle).toHaveBeenCalledWith(
      SESSION_ID,
      'Generated Session Title',
    );
  });

  it('falls back to the first persisted user text and strips noisy blocks', async () => {
    const { app, generateSessionTitle } = mount(sessionWithRows([
      {
        role: 'user',
        content_json: JSON.stringify([
          {
            type: 'text',
            text: '<file_refs>src/a.ts</file_refs>\nCorrigir titulo automatico',
          },
        ]),
      },
    ]));

    const res = await postGenerateTitle(app, {});

    expect(res.status).toBe(200);
    expect(generateSessionTitle).toHaveBeenCalledWith({
      userMessage: 'Corrigir titulo automatico',
    });
  });

  it('returns 412 when the session-title pipeline is not configured', async () => {
    const { app, generateSessionTitle } = mount(sessionWithRows());
    generateSessionTitle.mockResolvedValueOnce({
      status: 'unconfigured',
      title: null,
      latencyMs: 1,
    });

    const res = await postGenerateTitle(app, { content: 'Criar titulo' });
    const body = await res.json() as { code?: string };

    expect(res.status).toBe(412);
    expect(body.code).toBe('session_title_not_configured');
  });
});
