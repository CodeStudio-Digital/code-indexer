import { describe, expect, it, vi } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
}));

vi.mock('@mcp/api-handlers', () => ({
  createContext: (value?: unknown) => value ?? {},
  createSearchHandlers: () => ({
    project: mocks.project,
    global: vi.fn(),
    symbols: vi.fn(),
    text: vi.fn(),
    grep: vi.fn(),
    replace: vi.fn(),
  }),
}));

import { mountSearchRoutes } from '../search.js';

describe('project search route', () => {
  it('forwards an explicit cache bypass only for diagnostic calls', async () => {
    mocks.project.mockResolvedValueOnce({
      results: [],
      diagnostics: {
        vectorAvailable: true,
        embeddingAvailable: true,
        requestedMode: 'hybrid',
        plannedMode: 'hybrid',
        effectiveMode: 'hybrid',
        cacheHit: false,
        totalTimeMs: 12,
      },
    });
    const app = new HttpRouter();
    mountSearchRoutes(app, {} as ServerDeps);

    const response = await app.request(
      '/api/projects/7/search?q=where+is+the+agent&mode=hybrid&type=all&limit=10&supersessionKey=semantic-test%3Ap7&bypassCache=1',
    );
    const payload = await response.json() as { diagnostics: { cacheHit?: boolean; totalTimeMs?: number } };

    expect(response.status).toBe(200);
    expect(payload.diagnostics).toMatchObject({ cacheHit: false, totalTimeMs: 12 });
    expect(mocks.project).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 7,
      query: 'where is the agent',
      mode: 'hybrid',
      type: 'all',
      limit: 10,
      bypassCache: true,
      supersessionKey: 'semantic-test:p7',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('attributes an MCP search only after validating session project authority', async () => {
    mocks.project.mockResolvedValueOnce({ results: [], diagnostics: {} });
    const app = new HttpRouter();
    mountSearchRoutes(app, {
      sessionStore: {
        getSession: vi.fn(async () => ({
          id: 'session-7',
          project_id: 7,
          is_global: false,
          linked_projects: [],
        })),
      },
      db: {
        getProject: (id: number) => id === 7
          ? { id, name: 'demo', root_path: 'D:/demo', is_synthetic: 0 }
          : null,
      },
    } as unknown as ServerDeps);

    const response = await app.request(
      '/api/projects/7/search?q=where+is+the+agent&mode=auto&consumer=agent',
      { headers: { 'x-mcp-session-id': 'session-7' } },
    );

    expect(response.status).toBe(200);
    expect(mocks.project).toHaveBeenCalledWith(
      expect.objectContaining({ consumer: 'agent' }),
      expect.objectContaining({
        telemetryScope: { sessionId: 'session-7' },
      }),
    );
  });
});
