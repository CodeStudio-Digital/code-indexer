import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { guardWorkspaceRequest } from './guards.js';
import { listDir } from './file-service.js';

export function mountTreeRoutes(app: HttpRouter, deps: ServerDeps): void {
  app.get('/api/company/sessions/:sid/projects/:pid/tree', async (c) => {
    const relPath = c.req.query('path') ?? '.';
    const showHidden = c.req.query('showHidden') === 'true';
    const guard = await guardWorkspaceRequest(c, deps, relPath);
    if (guard instanceof Response) return guard;
    try {
      const entries = await listDir(guard.resolved.abs, { showHidden });
      return c.json({ path: relPath, entries });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });
}
