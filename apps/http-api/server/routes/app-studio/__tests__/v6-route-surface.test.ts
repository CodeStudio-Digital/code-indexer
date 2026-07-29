import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { runAppStudioScaffoldStream } from '@mcp/api-handlers';
import type { ServerDeps } from '../../../deps.js';

vi.mock('@mcp/api-handlers', () => ({
  runAppStudioScaffoldStream: vi.fn(),
  runAppLaunchStream: vi.fn(),
  runWranglerLoginStream: vi.fn(),
  runWranglerWhoami: vi.fn(),
}));

import { mountAppStudioRoutes } from '../index.js';

const LEGACY_SESSION_ID = '00000000-0000-4000-8000-000000000007';

function mountedApp(): Hono {
  const app = new Hono();
  mountAppStudioRoutes(app, {
    config: { features: { appStudioEnabled: true } },
  } as unknown as ServerDeps);
  return app;
}

describe('App Studio v6 HTTP surface', () => {
  it('forwards execution mode and native reasoning effort as separate create fields', async () => {
    const runScaffold = vi.mocked(runAppStudioScaffoldStream);
    runScaffold.mockImplementationOnce(async (_deps, _input, emit) => {
      emit({ event: 'done', data: { ok: true } } as never);
    });
    const payload = {
      name: 'Ultra App',
      provider: 'openai',
      model: 'gpt-5',
      execution_mode: 'ultra',
      reasoning_effort: 'high',
    };

    const response = await mountedApp().request('/api/app-studio/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(runScaffold).toHaveBeenCalledOnce();
    expect(runScaffold.mock.calls[0]?.[1]).toEqual(payload);
  });

  it.each([
    '/api/app-studio/sessions',
    `/api/app-studio/sessions/${LEGACY_SESSION_ID}/spec`,
    `/api/app-studio/sessions/${LEGACY_SESSION_ID}/product`,
    `/api/app-studio/sessions/${LEGACY_SESSION_ID}/architecture`,
    `/api/app-studio/sessions/${LEGACY_SESSION_ID}/workflow`,
    `/api/app-studio/sessions/${LEGACY_SESSION_ID}/agents`,
  ])('does not mount the v5 route %s', async (path) => {
    const response = await mountedApp().request(path);
    expect(response.status).toBe(404);
  });
});
