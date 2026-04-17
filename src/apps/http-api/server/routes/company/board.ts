import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseIntQuery } from '../_helpers.js';

export function mountCompanyBoardRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.get('/api/company/sessions/:id/board', (c) => {
    const id = parseIdParam(c);
    const sinceId = parseIntQuery(c, 'since_id', 0) || undefined;
    const limit = parseIntQuery(c, 'limit', 50);
    const kind = c.req.query('kind') as 'message' | 'decision' | 'question' | 'deliverable' | 'handoff' | undefined;

    const entries = companyStore.readBoard(id, { sinceId, limit, kind });
    return c.json(entries);
  });
}
