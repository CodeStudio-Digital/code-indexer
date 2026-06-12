import type { Context, Hono } from 'hono';
import { createSnapshotsHandlers, createContext } from '@mcp/api-handlers';
import { ApiError } from '@mcp/api-bus';
import type { SnapshotCategory } from '@mcp/shared/types.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountSnapshotsRoutes(app: Hono, deps: ServerDeps): void {
  const h = createSnapshotsHandlers(deps);

  app.get('/api/projects/:id/snapshots', async (c) => {
    try {
      const category = c.req.query('category') as SnapshotCategory | undefined;
      return c.json(await h.list({ projectId: parseIdParam(c), category }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/snapshots', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<{
        title: string;
        category: SnapshotCategory;
        content: string;
        tags?: string[];
      }>();
      return c.json(await h.create({ projectId, ...body }, createContext()), 201);
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.put('/api/snapshots/:id', async (c) => {
    try {
      const body = await c.req.json<{
        title?: string;
        category?: SnapshotCategory;
        content?: string;
        tags?: string[];
        importance?: number;
      }>();
      return c.json(await h.update({ id: parseIdParam(c), ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  // Memory health — feeds the project Memory tab's diagnostics card: when
  // the project last distilled (and with what result), plus memory totals
  // by category and provenance. Read-only over memory_distill_log (mig 136).
  app.get('/api/projects/:id/memory/health', (c) => {
    const projectId = parseIdParam(c);
    const project = deps.db.getProject(projectId);
    if (!project) return c.json({ error: 'project not found' }, 404);
    return c.json({
      memory_enabled: deps.db.getProjectMemoryEnabled(projectId),
      last: deps.db.latestMemoryDistill(projectId),
      recent: deps.db.recentMemoryDistills(projectId, 10),
      totals: {
        total: deps.db.countSnapshots(projectId),
        byCategory: deps.db.countMemoryByCategory(projectId),
        bySource: deps.db.countMemoryBySource(projectId),
      },
    });
  });

  app.delete('/api/snapshots/:id', async (c) => {
    try {
      return c.json(await h.delete({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/context', async (c) => {
    try {
      return c.text(await h.getForContext({ projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/snapshots/:id/history', async (c) => {
    try {
      return c.json(await h.history({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });
}
