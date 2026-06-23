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

  /**
   * Per-agent unread board counts. The dashboard agent panel uses this
   * to render a "X unread" badge next to each agent so the operator can
   * spot when a subordinate has board context it hasn't acknowledged
   * yet. Backed by migration 106 `agent_board_watermarks` — agents that
   * never watermarked yet show the FULL post count.
   */
  app.get('/api/company/sessions/:id/board/unread', (c) => {
    const id = parseIdParam(c);
    return c.json({ counts: companyStore.listUnreadBoardCounts(id) });
  });
}
