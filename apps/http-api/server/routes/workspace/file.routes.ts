import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { guardWorkspaceRequest } from './guards.js';
import { readText } from './file-service.js';

export function mountFileRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/company/sessions/:sid/projects/:pid/file', async (c) => {
    const relPath = c.req.query('path') ?? '';
    if (!relPath) return c.json({ error: 'Missing path query' }, 400);
    const guard = await guardWorkspaceRequest(c, deps, relPath);
    if (guard instanceof Response) return guard;
    try {
      const result = await readText(guard.resolved.abs);
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });
}
