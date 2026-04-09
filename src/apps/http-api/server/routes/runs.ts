import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';

export function mountRunsRoutes(app: Hono, deps: ServerDeps): void {
  const { db } = deps;

  app.get('/api/projects/:id/runs', (c) => {
    return c.json(db.getRuns(parseInt(c.req.param('id'), 10)));
  });

  app.get('/api/runs/:id', (c) => {
    const run = db.getRun(parseInt(c.req.param('id'), 10));
    if (!run) return c.json({ error: 'Not found' }, 404);
    return c.json(run);
  });
}
