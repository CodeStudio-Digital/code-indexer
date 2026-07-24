import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { activeOrchestrators } from './stream.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { InboxStatus } from '@mcp/company/types.js';
import {
  appOwnedControlPlaneConflict,
  isAppOwnedCompanySession,
} from './runtime-capabilities.js';

/**
 * HTTP routes for the agent inbox.
 *
 * Read-only listing falls through to `companyStore` so the dashboard
 * panel works even when the session isn't running. Mutations (cancel,
 * human respond) require the orchestrator to be loaded so the metaBus
 * gets the SSE event downstream listeners need.
 */
export function mountCompanyInboxRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.get('/api/company/sessions/:id/inbox', async (c) => {
    const sessionId = parseIdParam(c);
    const status = c.req.query('status') as InboxStatus | undefined;
    const toRole = c.req.query('to_role') ?? undefined;
    const orchestrator = activeOrchestrators.get(sessionId);

    if (orchestrator) {
      return c.json(await orchestrator.inboxList({ status, toRole }));
    }
    return c.json(
      companyStore.listInboxMessages({
        companySessionId: sessionId,
        status,
        toRole,
      }),
    );
  });

  app.post('/api/company/sessions/:id/inbox/:msgId/cancel', async (c) => {
    const sessionId = parseIdParam(c);
    if (isAppOwnedCompanySession(companyStore, sessionId)) {
      return appOwnedControlPlaneConflict(c, 'inbox cancellation');
    }
    const msgId = parseIdParam(c, 'msgId');
    const body = await parseJsonBody<{ reason?: string }>(c);
    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) return c.json({ error: 'Session is not running.' }, 409);
    const ok = await orchestrator.inboxCancel(msgId, body.reason ?? 'cancelled by operator');
    if (!ok) return notFound(c, 'Message not found or already terminal.');
    return c.json({ ok: true });
  });

  /**
   * Operator override: answer on behalf of a stuck role. Useful when
   * a subordinate dies without responding and the dashboard needs to
   * unblock the sender. The sender's `wait_token` resolves with the
   * provided answer just as if the target had called `respond_to_inbox`.
   */
  app.post('/api/company/sessions/:id/inbox/:msgId/respond', async (c) => {
    const sessionId = parseIdParam(c);
    if (isAppOwnedCompanySession(companyStore, sessionId)) {
      return appOwnedControlPlaneConflict(c, 'inbox operator response');
    }
    const msgId = parseIdParam(c, 'msgId');
    const body = await parseJsonBody<{ answer?: string }>(c);
    const answer = String(body.answer ?? '').trim();
    if (!answer) return c.json({ error: 'answer is required' }, 400);
    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) return c.json({ error: 'Session is not running.' }, 409);
    const ok = await orchestrator.inboxRespond(msgId, answer);
    if (!ok) return notFound(c, 'Message not found or already terminal.');
    return c.json({ ok: true });
  });
}
