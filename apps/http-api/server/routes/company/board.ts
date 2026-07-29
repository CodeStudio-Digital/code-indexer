import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import {
  parseCompanySessionIdParam,
  parseIntQuery,
} from '../_helpers.js';

export function mountCompanyBoardRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore } = deps;

  app.get('/api/company/sessions/:id/board', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const sinceSeq = parseIntQuery(c, 'since_seq', 0) || undefined;
    const limit = parseIntQuery(c, 'limit', 50);
    const kind = c.req.query('kind') as
      | 'message'
      | 'decision'
      | 'question'
      | 'deliverable'
      | 'handoff'
      | 'blocker'
      | undefined;

    await sessionStore.ensureCatalog();
    const files = new CompanySessionFiles({
      companySessionId: id,
      sessionStore,
    });
    return c.json(
      files.listBoardEntriesSync({ sinceSeq, limit, kind }),
    );
  });

  /**
   * Per-agent unread board counts. The dashboard agent panel uses this
   * to render a "X unread" badge next to each agent so the operator can
   * spot when a subordinate has board context it hasn't acknowledged.
   * Watermarks live in each independent agent-run JSON file.
   */
  app.get('/api/company/sessions/:id/board/unread', async (c) => {
    const id = parseCompanySessionIdParam(c);
    await sessionStore.ensureCatalog();
    const files = new CompanySessionFiles({
      companySessionId: id,
      sessionStore,
    });
    return c.json({ counts: files.listUnreadBoardCountsSync() });
  });
}
