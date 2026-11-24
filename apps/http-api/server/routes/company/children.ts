/**
 * Filesystem-backed Company sub-session ("front tabs") lifecycle.
 *
 * Child identity and parent linkage live in each bundle's `session.json`.
 * Archiving only changes `state.json`; it never removes or rewrites the
 * child's conversation and artifacts.
 */
import type { HttpRouter } from '@mcp/shared/http/router.js';
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
import { asSessionId, asCompanySessionId } from '@mcp/session-storage';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { CompanyWorkspaceCoordinator } from '@mcp/company/services/workspace-coordinator.js';
import { companyConfigRevision } from '@mcp/company/services/session-identity.js';
import { withSessionLock } from '../coder/sessionLock.js';
import { publishCompanyPanelChange } from '../../../sse/notification-event-bus.js';

interface CreateChildBody { name: string; workspace?: 'shared' | 'isolated' }
interface RenameChildBody { name: string }

export function mountCompanyChildRoutes(app: HttpRouter, deps: ServerDeps): void {
  app.get('/api/company/companies/:id/workspace', async c => {
    const id = parseCompanySessionIdParam(c);
    const session = await deps.operationalSessionFiles.getCompanySession(id);
    if (!session || session.parent_session_id) return notFound(c, 'company not found');
    await deps.sessionStore.ensureCatalog();
    const files = new CompanySessionFiles({ companySessionId: id, sessionStore: deps.sessionStore });
    const coordinator = new CompanyWorkspaceCoordinator(files.location.bundle_path);
    const owners = await coordinator.owners();
    const orphanTokens = owners.filter(owner => owner.phase === 'running' && !getCompanyOrchestrator(asCompanySessionId(owner.sessionId))).map(owner => owner.token);
    // Missing worker proves that its invocation cannot report completion; it
    // does not prove any external process stopped. Classify, never release.
    await coordinator.markStoppedOwnersUncertain(orphanTokens);
    const currentOwners = orphanTokens.length ? await coordinator.owners() : owners;
    return c.json({ mode: 'shared', write_policy: 'serialized_mutations', owners: await Promise.all(currentOwners.map(async owner => {
      const ownerActive = Boolean(getCompanyOrchestrator(asCompanySessionId(owner.sessionId)));
      const ownerSession = await deps.operationalSessionFiles.getCompanySession(owner.sessionId);
      return { ...owner, ownerActive, reviewable: !ownerActive && Boolean(ownerSession) };
    })) });
  });
  app.post('/api/company/companies/:id/workspace/reconcile', async c => {
    const id = parseCompanySessionIdParam(c);
    const session = await deps.operationalSessionFiles.getCompanySession(id);
    if (!session || session.parent_session_id) return notFound(c, 'company not found');
    const body = await parseJsonBody<{ reviewed?: boolean; tokens?: string[] }>(c);
    if (body.reviewed !== true || !Array.isArray(body.tokens) || !body.tokens.length || body.tokens.some(token => typeof token !== 'string')) {
      return c.json({ error: 'Review the file and process outcomes and provide the exact observed operation tokens.' }, 400);
    }
    await deps.sessionStore.ensureCatalog();
    const files = new CompanySessionFiles({ companySessionId: id, sessionStore: deps.sessionStore });
    const coordinator = new CompanyWorkspaceCoordinator(files.location.bundle_path);
    const owners = await coordinator.owners();
    const observed = owners.filter(item => body.tokens!.includes(item.token));
    const ownerSessionIds = [...new Set(observed.map(owner => owner.sessionId))].sort();
    // Share the same locks as session start/resume, in stable order. A stale
    // persisted "running" status is not proof of a live worker after a crash.
    const reconcileLocked = async (index: number): Promise<Response> => {
      if (index < ownerSessionIds.length) return withSessionLock(ownerSessionIds[index]!, () => reconcileLocked(index + 1));
      for (const owner of observed) {
        if (getCompanyOrchestrator(asCompanySessionId(owner.sessionId))) return c.json({ error: 'Pause the owning session before reconciling its effects.', code: 'WORKSPACE_OWNER_ACTIVE' }, 409);
        if (!await deps.operationalSessionFiles.getCompanySession(owner.sessionId)) return c.json({ error: 'Owner session is unavailable; restore its record before reconciliation.' }, 409);
      }
      await coordinator.markStoppedOwnersUncertain(observed.map(owner => owner.token));
      try { await coordinator.reconcile(body.tokens!); }
      catch (error) { return c.json({ error: String(error) }, 409); }
      return c.json({ ok: true, original_outcomes: 'unchanged', receipt: publishCompanyPanelChange(id, { kind: 'workspace' }) });
    };
    return reconcileLocked(0);
  });
  app.post('/api/company/companies/:id/sessions/:childId/config/adopt', async c => {
    const id = parseCompanySessionIdParam(c);
    const childId = parseCompanySessionIdParam(c, 'childId');
    const parent = await deps.operationalSessionFiles.getCompanySession(id);
    const child = await deps.operationalSessionFiles.getCompanySession(childId);
    if (!parent || parent.parent_session_id || !child || child.parent_session_id !== id) return notFound(c);
    if (getCompanyOrchestrator(childId) || child.status === 'running' || child.status === 'paused') return c.json({ error: 'Stop this session before adopting company configuration.', code: 'SESSION_ACTIVE' }, 409);
    const body = await parseJsonBody<{ expectedCompanyRevision?: string; expectedSessionRevision?: string }>(c);
    if (body.expectedCompanyRevision !== companyConfigRevision(parent.config_json) || body.expectedSessionRevision !== companyConfigRevision(child.config_json)) {
      return c.json({ error: 'Configuration changed. Refresh before adopting it.', code: 'CONFIGURATION_REVISION_CONFLICT' }, 409);
    }
    await deps.sessionStore.ensureCatalog();
    const files = new CompanySessionFiles({ companySessionId: childId, sessionStore: deps.sessionStore });
    await files.updateSessionConfig(parent.config_json, { revision: body.expectedCompanyRevision, inherited_from: id });
    return c.json({ session: files.getSession(), receipt: publishCompanyPanelChange(childId, { kind: 'settings' }) });
  });
  app.on('GET', ['/api/company/sessions/:id/children', '/api/company/companies/:id/sessions'], async (c) => {
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
    return c.json({ parent: root, children, company: { id: root.id, name: root.name }, sessions: [root, ...children] });
  });

  app.on('POST', ['/api/company/sessions/:id/children', '/api/company/companies/:id/sessions'], async (c) => {
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
    if (body.workspace && body.workspace !== 'shared') return c.json({ error: 'Isolated workspaces are not provisioned for Company sessions. Choose shared workspace.', code: 'WORKSPACE_MODE_UNAVAILABLE' }, 409);
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
