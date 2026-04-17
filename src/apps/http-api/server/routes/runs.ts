import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';

export function mountRunsRoutes(app: Hono, deps: ServerDeps): void {
  const { db } = deps;

  app.get('/api/projects/:id/runs', (c) => {
    return c.json(db.getRuns(parseIdParam(c)));
  });

  app.get('/api/runs/:id', (c) => {
    const run = db.getRun(parseIdParam(c));
    if (!run) return notFound(c);
    return c.json(run);
  });
}
