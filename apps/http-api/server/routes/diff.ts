import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';

export function mountDiffRoutes(app: Hono, deps: ServerDeps): void {
  const { diffService } = deps;

  app.get('/api/projects/:id/diff', (c) => {
    const projectId = parseIdParam(c);
    const runBefore = c.req.query('run_before');
    const runAfter = c.req.query('run_after');

    let diff;
    if (runBefore && runAfter) {
      const before = parseInt(runBefore, 10);
      const after = parseInt(runAfter, 10);
      // Cross-project isolation: run ids are global, and getFileSnapshots scopes
      // by run id alone — only diff runs that belong to THIS project so a caller
      // can't read another project's file snapshots (paths, symbols, concepts)
      // by passing foreign run ids.
      const ownsBoth = deps.db.getRun(before)?.project_id === projectId
        && deps.db.getRun(after)?.project_id === projectId;
      if (!ownsBoth) return notFound(c, 'Run not found in this project');
      diff = diffService.diff(projectId, before, after);
    } else {
      diff = diffService.diffLatest(projectId);
    }

    if (!diff) return notFound(c, 'Not enough runs');
    return c.json(diff);
  });
}
