import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { activeOrchestrators } from './stream.js';
import {
  parseCompanySessionIdParam,
  parseJsonBody,
  parseSessionRecordIdParam,
  notFound,
} from '../_helpers.js';
import type { InboxStatus } from '@mcp/company/types.js';
import { appOwnedControlPlaneConflict } from './runtime-capabilities.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { CompanySessionMessenger } from '@mcp/company/services/session-messenger.js';

/**
 * HTTP routes for the agent inbox.
 *
 * Read-only listing falls through to the filesystem bundle so the dashboard
 * panel works even when the session isn't running. Mutations (cancel,
 * human respond) require the orchestrator to be loaded so the metaBus
 * gets the SSE event downstream listeners need.
 */
export function mountCompanyInboxRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore } = deps;

  const filesFor = async (
    sessionId: ReturnType<typeof parseCompanySessionIdParam>,
  ): Promise<CompanySessionFiles> => {
    await sessionStore.ensureCatalog();
    return new CompanySessionFiles({
      companySessionId: sessionId,
      sessionStore,
    });
  };

  app.post('/api/company/sessions/:id/messages', async c => {
    const sourceId = parseCompanySessionIdParam(c);
    const source = await deps.operationalSessionFiles.getCompanySession(sourceId);
    if (!source) return notFound(c, 'source session not found');
    if (source.runtime_kind !== 'company') return appOwnedControlPlaneConflict(c, 'company messaging');
    const body = await parseJsonBody<{ targetSessionId?: string; targetAgentRunId?: string; targetRole?: string; body?: string; kind?: 'notify' | 'question'; idempotencyKey?: string }>(c);
    if (!body.targetSessionId || !body.body?.trim() || !body.idempotencyKey || (body.kind && !['notify', 'question'].includes(body.kind))) return c.json({ error: 'targetSessionId, body and idempotencyKey are required; kind must be notify or question' }, 400);
    try {
      const files = await filesFor(sourceId);
      const message = await new CompanySessionMessenger(files).send({ ...body, targetSessionId: body.targetSessionId, body: body.body, idempotencyKey: body.idempotencyKey }, 'operator');
      return c.json({ message, deliveredImmediately: false, targetSessionId: message.to_session_id }, 202);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });

  app.get('/api/company/sessions/:id/inbox', async (c) => {
    const sessionId = parseCompanySessionIdParam(c);
    const status = c.req.query('status') as InboxStatus | undefined;
    const toRole = c.req.query('to_role') ?? undefined;
    const orchestrator = activeOrchestrators.get(sessionId);

    if (orchestrator) {
      return c.json(await orchestrator.inboxList({ status, toRole }));
    }
    const files = await filesFor(sessionId);
    return c.json(files.listInboxMessagesSync({ status, toRole }));
  });

  app.post('/api/company/sessions/:id/inbox/:msgId/cancel', async (c) => {
    const sessionId = parseCompanySessionIdParam(c);
    const files = await filesFor(sessionId);
    if (files.getSession().runtime_kind === 'app_studio') {
      return appOwnedControlPlaneConflict(c, 'inbox cancellation');
    }
    const msgId = parseSessionRecordIdParam(c, 'msgId');
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
    const sessionId = parseCompanySessionIdParam(c);
    const files = await filesFor(sessionId);
    if (files.getSession().runtime_kind === 'app_studio') {
      return appOwnedControlPlaneConflict(c, 'inbox operator response');
    }
    const msgId = parseSessionRecordIdParam(c, 'msgId');
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
