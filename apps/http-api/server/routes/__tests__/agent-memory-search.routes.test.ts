import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountAgentMemoryRoutes } from '../agent-memory.js';

describe('agent-memory semantic RPC route', () => {
  it('keeps embedding/vector ownership in the server service', async () => {
    const search = vi.fn(async () => [{
      id: 4,
      project_id: 7,
      scope: 'project',
      name: 'Build recipe',
      type: 'procedure',
      content: 'Run the focused tests first.',
      source: 'agent',
      importance: 0.8,
      score: 0.03,
    }]);
    const app = new Hono();
    mountAgentMemoryRoutes(app, {
      db: { getProject: (id: number) => id === 7 ? { id, name: 'demo' } : null },
      agentMemoryService: { search },
    } as unknown as ServerDeps);

    const response = await app.request(
      '/api/projects/7/agent-memory/search?q=focused+tests&limit=3',
    );
    const payload = await response.json() as { results: Array<{ name: string }> };

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith('project', 7, 'focused tests', 3);
    expect(payload.results).toEqual([expect.objectContaining({ name: 'Build recipe' })]);
  });

  it('does not invoke retrieval for an empty query', async () => {
    const search = vi.fn();
    const app = new Hono();
    mountAgentMemoryRoutes(app, {
      db: { getProject: () => ({ id: 7, name: 'demo' }) },
      agentMemoryService: { search },
    } as unknown as ServerDeps);

    const response = await app.request('/api/projects/7/agent-memory/search?q=');
    expect(await response.json()).toEqual({ results: [] });
    expect(search).not.toHaveBeenCalled();
  });
});
