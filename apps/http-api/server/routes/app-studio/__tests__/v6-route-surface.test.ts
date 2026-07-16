import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';

vi.mock('@mcp/api-handlers', () => ({
  runAppStudioScaffoldStream: vi.fn(),
  runAppLaunchStream: vi.fn(),
  runWranglerLoginStream: vi.fn(),
  runWranglerWhoami: vi.fn(),
}));

import { mountAppStudioRoutes } from '../index.js';

function mountedApp(): Hono {
  const app = new Hono();
  mountAppStudioRoutes(app, {
    config: { features: { appStudioEnabled: true } },
  } as unknown as ServerDeps);
  return app;
}

describe('App Studio v6 HTTP surface', () => {
  it.each([
    '/api/app-studio/sessions',
    '/api/app-studio/sessions/7/spec',
    '/api/app-studio/sessions/7/product',
    '/api/app-studio/sessions/7/architecture',
    '/api/app-studio/sessions/7/workflow',
    '/api/app-studio/sessions/7/agents',
  ])('does not mount the v5 route %s', async (path) => {
    const response = await mountedApp().request(path);
    expect(response.status).toBe(404);
  });
});
