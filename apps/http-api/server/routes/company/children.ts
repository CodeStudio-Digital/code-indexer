/**
 * Sub-sessions ("front tabs") CRUD.
 *
 * Migration 067 replaces the per-row `front_id` model with a
 * `parent_session_id` link in `company_sessions`. A sub-session is a
 * full `CompanySession` with its own board / agent_runs / master_prompts
 * / inbox; siblings share the parent's sandbox / projects / kanban /
 * pipelines via runtime fallback.
 *
 * Routes:
 *   GET    /api/company/sessions/:id/children
 *           → { parent: CompanySession, children: CompanySession[] }
 *           Accepts a child's id too — resolves to the root of the tree.
 *   POST   /api/company/sessions/:id/children { name }
 *           → CompanySession; `:id` must be a root session.
 *   PATCH  /api/company/sessions/:id/children/:childId { name }
 *           → CompanySession (updated row).
 *   DELETE /api/company/sessions/:id/children/:childId
 *           → { ok: true }; runs through the existing archive flow so
 *           runtime is torn down and rows get an `archive_id`.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import {
  evictCompanyOrchestrator,
  getCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import { publish as busPublish } from '../../../coder-bus.js';

interface CreateChildBody { name: string }
interface RenameChildBody { name: string }

export function mountCompanyChildRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.get('/api/company/sessions/:id/children', (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c, 'session not found');

    // Always resolve from the root: if the caller passed a child id,
    // we still want to return the parent + all siblings of that tree.
    const rootId = session.parent_session_id ?? session.id;
    const root = rootId === session.id ? session : companyStore.getCompanySession(rootId);
    if (!root) return notFound(c, 'parent session not found');
    const children = companyStore.listChildSessions(root.id);
    return c.json({ parent: root, children });
  });

  app.post('/api/company/sessions/:id/children', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c, 'session not found');
    if (session.parent_session_id != null) {
      return c.json({ error: 'Cannot create sub-sessions of a sub-session' }, 400);
    }
    const body = await parseJsonBody<CreateChildBody>(c);
    const name = (body?.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);

    // Prefer the live orchestrator so the metaBus event is published to
    // any open SSE consumers; fall back to direct store when dormant.
    const orch = getCompanyOrchestrator(id);
    let child: ReturnType<typeof companyStore.createChildSession>;
    if (orch) {
      try {
        child = await orch.createChildSession(name);
      } catch (error) {
        if (isMutationOutcomeUnknownError(error)) {
          await evictCompanyOrchestrator(id);
          return c.json({
            error:
              'Sub-session creation outcome is unknown because its worker ' +
              'acknowledgement was lost; the mutation was not replayed.',
            code: 'OUTCOME_UNKNOWN',
          }, 500);
        }
        throw error;
      }
    } else {
      child = companyStore.createChildSession({ parent_session_id: id, name });
    }
    return c.json(child, 201);
  });

  app.patch('/api/company/sessions/:id/children/:childId', async (c) => {
    const id = parseIdParam(c);
    const childId = Number(c.req.param('childId'));
    if (!Number.isFinite(childId)) return c.json({ error: 'invalid childId' }, 400);

    const child = companyStore.getCompanySession(childId);
    if (!child || child.parent_session_id !== id) return notFound(c, 'sub-session not found');

    const body = await parseJsonBody<RenameChildBody>(c);
    const name = (body?.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);

    const orch = getCompanyOrchestrator(id);
    if (orch) {
      try {
        await orch.renameChildSession(childId, name);
      } catch (error) {
        if (isMutationOutcomeUnknownError(error)) {
          await evictCompanyOrchestrator(id);
          return c.json({
            error:
              'Sub-session rename outcome is unknown because its worker ' +
              'acknowledgement was lost.',
            code: 'OUTCOME_UNKNOWN',
          }, 500);
        }
        throw error;
      }
    } else {
      companyStore.renameCompanySession(childId, name);
    }

    return c.json(companyStore.getCompanySession(childId));
  });

  app.delete('/api/company/sessions/:id/children/:childId', async (c) => {
    const id = parseIdParam(c);
    const childId = Number(c.req.param('childId'));
    if (!Number.isFinite(childId)) return c.json({ error: 'invalid childId' }, 400);

    const child = companyStore.getCompanySession(childId);
    if (!child || child.parent_session_id !== id) return notFound(c, 'sub-session not found');

    // Tear down the child's orchestrator (if alive). Sub-sessions never
    // own their own sandbox/kanban — those live on the parent, so
    // includeKanban/includeSandbox stay false to avoid touching shared
    // state. Same archive path /sessions/:id/reset uses, scoped to the
    // child's own rows.
    const childOrch = getCompanyOrchestrator(childId);
    if (childOrch) {
      try {
        await childOrch.abortAll({ teardownSandbox: false, finalStatus: 'idle' });
      } catch (e) {
        console.warn(`[company/children] abortAll failed for ${childId}:`, e instanceof Error ? e.message : String(e));
      }
      await evictCompanyOrchestrator(childId);
    }
    try {
      companyStore.archiveCompanySession(childId, {
        reason: 'sub-session archived',
        includeKanban: false,
        includeSandbox: false,
      });
    } catch (e) {
      return c.json({ error: `Archive failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }

    // Notify the parent's metaBus so dashboard tabs update in real time.
    const parentOrch = getCompanyOrchestrator(id);
    if (parentOrch) {
      busPublish(parentOrch.metaBus, 'subsession_archived', { session_id: childId });
    }
    return c.json({ ok: true });
  });
}
