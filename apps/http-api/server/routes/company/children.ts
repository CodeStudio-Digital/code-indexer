/**
 * Filesystem-backed Company sub-session ("front tabs") lifecycle.
 *
 * Child identity and parent linkage live in each bundle's `session.json`.
 * Archiving only changes `state.json`; it never removes or rewrites the
 * child's conversation and artifacts.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import {
  notFound,
  parseCompanySessionIdParam,
  parseJsonBody,
} from '../_helpers.js';
import {
  evictCompanyOrchestrator,
  getCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import { publish as busPublish } from '../../../coder-bus.js';
import { asSessionId } from '@mcp/session-storage';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';

interface CreateChildBody { name: string }
interface RenameChildBody { name: string }

export function mountCompanyChildRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/company/sessions/:id/children', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const requested = await deps.operationalSessionFiles.getCompanySession(id);
    if (!requested) return notFound(c, 'session not found');
    const rootId = requested.parent_session_id ?? requested.id;
    const root = rootId === requested.id
      ? requested
      : await deps.operationalSessionFiles.getCompanySession(rootId);
    if (!root) return notFound(c, 'parent session not found');
    const all = await deps.operationalSessionFiles.listCompanySessions({
      includeChildren: true,
    });
    const children = all
      .filter(
        (session) =>
          session.parent_session_id === root.id &&
          session.archived_at == null,
      )
      .sort(
        (left, right) =>
          Date.parse(left.created_at) - Date.parse(right.created_at) ||
          left.id.localeCompare(right.id),
      );
    return c.json({ parent: root, children });
  });

  app.post('/api/company/sessions/:id/children', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const parent = await deps.operationalSessionFiles.getCompanySession(id);
    if (!parent) return notFound(c, 'session not found');
    if (parent.parent_session_id != null) {
      return c.json({ error: 'Cannot create sub-sessions of a sub-session' }, 400);
    }
    if (parent.runtime_kind !== 'company') {
      return c.json({ error: 'This runtime does not support Company sub-sessions' }, 409);
    }
    const body = await parseJsonBody<CreateChildBody>(c);
    const name = body.name?.trim() ?? '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    const full = await deps.operationalSessionFiles.getCompanySessionFull(id);
    if (!full) return notFound(c, 'session not found');

    const child = await deps.operationalSessionFiles.createCompanySession({
      parent_session_id: id,
      runtime_kind: 'company',
      template_id: parent.template_id,
      name,
      config_json: parent.config_json,
      project_ids: full.projects.map((project) => project.project_id),
      project_labels: Object.fromEntries(
        full.projects.map((project) => [
          project.project_id,
          project.label ?? undefined,
        ]),
      ),
    });
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      busPublish(orchestrator.metaBus, 'subsession_created', { session: child });
    }
    return c.json(child, 201);
  });

  app.patch('/api/company/sessions/:id/children/:childId', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const childId = parseCompanySessionIdParam(c, 'childId');
    const child = await deps.operationalSessionFiles.getCompanySession(childId);
    if (!child || child.parent_session_id !== id) {
      return notFound(c, 'sub-session not found');
    }
    const body = await parseJsonBody<RenameChildBody>(c);
    const name = body.name?.trim() ?? '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    const updated = await deps.operationalSessionFiles.renameCompanySession(
      childId,
      name,
    );
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      busPublish(orchestrator.metaBus, 'subsession_renamed', { session: updated });
    }
    return c.json(updated);
  });

  app.delete('/api/company/sessions/:id/children/:childId', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const childId = parseCompanySessionIdParam(c, 'childId');
    const child = await deps.operationalSessionFiles.getCompanySession(childId);
    if (!child || child.parent_session_id !== id) {
      return notFound(c, 'sub-session not found');
    }

    const childOrchestrator = getCompanyOrchestrator(childId);
    if (childOrchestrator) {
      try {
        await childOrchestrator.abortAll({
          teardownSandbox: false,
          finalStatus: 'idle',
        });
      } catch (error) {
        console.warn(
          `[company/children] abortAll failed for ${childId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      await evictCompanyOrchestrator(childId);
    }

    const files = new CompanySessionFiles({
      companySessionId: childId,
      sessionStore: deps.sessionStore,
    });
    await files.setMasterSessionId(null);
    await files.updateSessionStatus('idle');
    await deps.sessionStore.setSessionArchived(asSessionId(childId), true);

    const parentOrchestrator = getCompanyOrchestrator(id);
    if (parentOrchestrator) {
      busPublish(parentOrchestrator.metaBus, 'subsession_archived', {
        session_id: childId,
      });
    }
    return c.json({ ok: true, recoverable: true });
  });
}
