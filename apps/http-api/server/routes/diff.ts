import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';

export function mountDiffRoutes(app: Hono, deps: ServerDeps): void {
  const { diffService } = deps;

  app.get('/api/projects/:id/diff', (c) => {
    const projectId = parseIdParam(c);
    const runBefore = c.req.query('run_before');
    const runAfter = c.req.query('run_after');

    const diff = runBefore && runAfter
      ? diffService.diff(projectId, parseInt(runBefore, 10), parseInt(runAfter, 10))
      : diffService.diffLatest(projectId);

    if (!diff) return notFound(c, 'Not enough runs');
    return c.json(diff);
  });
}
