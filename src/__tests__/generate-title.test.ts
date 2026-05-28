import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ai = vi.hoisted(() => {
  class GeneralAiNotConfiguredError extends Error {
    constructor() {
      super('General AI is not configured.');
      this.name = 'GeneralAiNotConfiguredError';
    }
  }
  return {
    runGeneralAi: vi.fn(),
    GeneralAiNotConfiguredError,
  };
});

vi.mock('@mcp/services/ai-general/generalClient.js', () => ({
  runGeneralAi: ai.runGeneralAi,
  GeneralAiNotConfiguredError: ai.GeneralAiNotConfiguredError,
}));

import { mountCoderSessionsRoutes } from '../../apps/http-api/server/routes/coder/sessions.js';

function sessionWithRows(rows: Array<{ role: string; content_json: string }> = []) {
  return {
    session: {
      id: 793,
      project_id: 1,
      title: 'Nova sessao',
      provider: 'openai',
      model: 'gpt-4o-mini',
    },
    messages: [],
    message_rows: rows.map((row, idx) => ({
      id: idx + 1,
      session_id: 793,
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
  const sessionStore = {
    loadSessionWithMessages: vi.fn(() => data),
    setSessionTitle: vi.fn(),
  };
  mountCoderSessionsRoutes(
    app,
    {
      sessionStore,
      providerStore: {},
    } as never,
    {
      activeRuns: new Map(),
    } as never,
  );
  return { app, sessionStore };
}

async function postGenerateTitle(app: Hono, body: unknown) {
  return app.request('/api/coder/sessions/793/generate-title', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('coder generate-title route', () => {
  beforeEach(() => {
    ai.runGeneralAi.mockReset();
    ai.runGeneralAi.mockResolvedValue('Generated Session Title');
  });

  it('uses the message text sent in the request body', async () => {
    const { app, sessionStore } = mount(sessionWithRows());

    const res = await postGenerateTitle(app, {
      content: 'Bug: generate-title nao recebe o primeiro texto enviado',
    });

    expect(res.status).toBe(200);
    expect(ai.runGeneralAi).toHaveBeenCalledWith(
      expect.stringContaining('Bug: generate-title nao recebe o primeiro texto enviado'),
      expect.objectContaining({ system: expect.any(String) }),
    );
    expect(sessionStore.setSessionTitle).toHaveBeenCalledWith(793, 'Generated Session Title');
  });

  it('falls back to the first persisted user text and strips noisy blocks', async () => {
    const { app } = mount(sessionWithRows([
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
    const prompt = ai.runGeneralAi.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('Corrigir titulo automatico');
    expect(prompt).not.toContain('<file_refs>');
  });

  it('returns 412 when general AI is not configured', async () => {
    ai.runGeneralAi.mockRejectedValue(new ai.GeneralAiNotConfiguredError());
    const { app } = mount(sessionWithRows());

    const res = await postGenerateTitle(app, { content: 'Criar titulo' });
    const body = await res.json() as { code?: string };

    expect(res.status).toBe(412);
    expect(body.code).toBe('general_ai_not_configured');
  });
});
