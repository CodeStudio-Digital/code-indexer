import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';

export function mountCompanyBoardRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.get('/api/company/sessions/:id/board', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const sinceId = parseInt(c.req.query('since_id') ?? '0', 10) || undefined;
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const kind = c.req.query('kind') as 'message' | 'decision' | 'question' | 'deliverable' | 'handoff' | undefined;

    const entries = companyStore.readBoard(id, { sinceId, limit, kind });
    return c.json(entries);
  });
}
