import type { Hono } from 'hono';
import type { SnapshotCategory } from '../../../../types.js';
import type { ServerDeps } from '../deps.js';

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
    return c.json(snapshotService.list(parseInt(c.req.param('id'), 10), category));
  });

  app.post('/api/projects/:id/snapshots', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<CreateSnapshotBody>();
    const snap = snapshotService.create(projectId, body);
    return c.json(snap, 201);
  });

  app.put('/api/snapshots/:id', async (c) => {
    const body = await c.req.json<UpdateSnapshotBody>();
    snapshotService.update(parseInt(c.req.param('id'), 10), body);
    return c.json({ ok: true });
  });

  app.delete('/api/snapshots/:id', (c) => {
    snapshotService.delete(parseInt(c.req.param('id'), 10));
    return c.json({ ok: true });
  });

  app.get('/api/projects/:id/context', (c) => {
    return c.text(snapshotService.getForContext(parseInt(c.req.param('id'), 10)));
  });

  app.get('/api/snapshots/:id/history', (c) => {
    return c.json(snapshotService.getHistory(parseInt(c.req.param('id'), 10)));
  });
}
