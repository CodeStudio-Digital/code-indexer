import type { Hono } from 'hono';
import type { SnapshotCategory } from '../../../../types.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';

interface CreateSnapshotBody {
  title: string;
  category: SnapshotCategory;
  content: string;
  tags?: string[];
}

interface UpdateSnapshotBody {
  title?: string;
  category?: SnapshotCategory;
  content?: string;
  tags?: string[];
}

export function mountSnapshotsRoutes(app: Hono, deps: ServerDeps): void {
  const { snapshotService } = deps;

  app.get('/api/projects/:id/snapshots', (c) => {
    const category = c.req.query('category') as SnapshotCategory | undefined;
    return c.json(snapshotService.list(parseIdParam(c), category));
  });

  app.post('/api/projects/:id/snapshots', async (c) => {
    const projectId = parseIdParam(c);
    const body = await c.req.json<CreateSnapshotBody>();
    const result = await snapshotService.create(projectId, body);
    return c.json({ ...result.snap, embed_error: result.embedError ?? null }, 201);
  });

  app.put('/api/snapshots/:id', async (c) => {
    const body = await c.req.json<UpdateSnapshotBody>();
    const result = await snapshotService.update(parseIdParam(c), body);
    return c.json({ ok: true, embed_error: result.embedError ?? null });
  });

  app.delete('/api/snapshots/:id', (c) => {
    snapshotService.delete(parseIdParam(c));
    return c.json({ ok: true });
  });

  app.get('/api/projects/:id/context', (c) => {
    return c.text(snapshotService.getForContext(parseIdParam(c)));
  });

  app.get('/api/snapshots/:id/history', (c) => {
    return c.json(snapshotService.getHistory(parseIdParam(c)));
  });
}
