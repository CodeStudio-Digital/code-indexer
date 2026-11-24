import type { HttpRouter } from '@mcp/shared/http/router.js';
import { withDefaultQaSkill } from '@mcp/company-contracts/qa-defaults.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';
import { getCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import { notifyCompanySettingsChanged } from '../../../sse/workerPoolSingleton.js';
import { mergeAutonomyPatch, sanitizeAutonomyPatch } from '@mcp/company/services/autonomy/autonomy-patch.js';
import { withSessionLock } from '../coder/sessionLock.js';
import { linkedProjectService, mountCompanyProjectRoutes } from './session-projects.js';
import type { ServerDeps } from '../../deps.js';
import type {
  CompanySessionFileRow,
  CreateCompanyFileSessionInput,
} from '../../operational-session-files.js';
import {
  notFound,
  parseCompanySessionIdParam,
  parseJsonBody,
} from '../_helpers.js';
import {
  resolveRoleProjectBindings,
  validateAllowedModels,
  type CreateSessionBody,
} from './session-create-validation.js';

function runtimeEnvelope(session: CompanySessionFileRow) {
  return {
    app_session_id:
      session.runtime_kind === 'app_studio' ? session.id : null,
    capabilities: resolveCompanySessionCapabilities(
      session.runtime_kind,
      null,
    ),
  };
}

async function enrichedFull(
  deps: ServerDeps,
  id: string,
) {
  const full = await deps.operationalSessionFiles.getCompanySessionFull(id);
  if (!full) return null;
  const services = new Set(!full.session.parent_session_id && full.projects.some(p => p.label)
    ? deps.companySandboxServicesStore.listBySessionAll(id).map(s => s.service_id) : []);
  const projectIds = full.projects.map(p => p.project_id);
  const labels = Object.fromEntries(full.projects.map(p => [String(p.project_id), p.label]));
  return {
    ...full,
    ...runtimeEnvelope(full.session),
    projects: full.projects.map((link) => {
      const project = deps.db.getProject(link.project_id);
      return {
        ...link,
        is_service: !!linkedProjectService(link.project_id, projectIds, labels, services),
        project_name: project?.name ?? `project-${link.project_id}`,
        root_path: project?.root_path ?? '',
      };
    }),
  };
}

/**
 * Big-bang Company/App Studio session lifecycle. Templates stay in
 * `CompanyStore`; every route here reads and writes only the owning bundle.
 */
export function mountCompanyFileSessionRoutes(
  app: HttpRouter,
  deps: ServerDeps,
  options: { includeDelete?: boolean } = {},
): void {
  const sessions = deps.operationalSessionFiles;
  mountCompanyProjectRoutes(app, deps);
  const visible = (row:CompanySessionFileRow) => {
    if (!row.config_json?.includes('design_pending')) return true;
    return !JSON.parse(row.config_json).design_pending;
  };

  app.get('/api/company/sessions', async (c) => {
    const status = c.req.query('status');
    const rows = await sessions.listCompanySessions(
      status ? { status } : {},
    );
    return c.json(rows.filter(visible).map((row) => ({ ...row, ...runtimeEnvelope(row) })));
  });

  app.get('/api/company/companies', async c => {
    const status = c.req.query('status');
    // Metadata only: no transcripts, agent histories or tool results are read.
    const all = await sessions.listCompanySessions({ includeChildren: true });
    const families = new Map<string, CompanySessionFileRow[]>();
    for (const row of all) {
      if (row.archived_at) continue;
      const companyId = row.parent_session_id ?? row.id;
      const family = families.get(companyId) ?? [];
      family.push(row);
      families.set(companyId, family);
    }
    const rows = all.filter(row => !row.parent_session_id && !row.archived_at && visible(row)).map(row => {
      const family = families.get(row.id) ?? [row];
      const running_sessions = family.filter(item => item.status === 'running').length;
      const paused_sessions = family.filter(item => item.status === 'paused').length;
      const attention_sessions = family.filter(item => item.status === 'error').length;
      const aggregate_status = running_sessions ? 'running' : attention_sessions ? 'error' : paused_sessions ? 'paused' : family.every(item => item.status === 'completed') ? 'completed' : 'idle';
      return { ...row, ...runtimeEnvelope(row), session_count: family.length, running_sessions, paused_sessions, attention_sessions, aggregate_status };
    });
    return c.json(status ? rows.filter(row => row.aggregate_status === status) : rows);
  });

  app.get('/api/company/sessions/:id', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const full = await enrichedFull(deps, id);
    return full ? c.json(full) : notFound(c);
  });

  app.get('/api/company/sessions/:id/state-snapshot', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const full = await enrichedFull(deps, id);
    if (!full) return notFound(c);
    const inbox = await sessions.company(id);
    const pending = await inbox.list('inboxMessage', {
      limit: 50,
    });
    let liveOrchestrator = false;
    let masterAlive = false;
    let masterEndedAt: string | null = null;
    try {
      const orchestrator = getCompanyOrchestrator(id);
      if (orchestrator) {
        const status = await orchestrator.getMasterStatus();
        liveOrchestrator = !orchestrator.metaBus.ended;
        masterAlive = status.alive;
        masterEndedAt = status.endedAt;
      }
    } catch {
      // Minimal/test hosts can lack a pool. A failed RPC is never reported alive.
    }
    return c.json({
      ...full,
      liveOrchestrator,
      masterAlive,
      masterEndedAt,
      pendingMasterInboxCount: pending.items.filter(
        (item) =>
          item.data.status === 'pending' &&
          (item.data.to_role === '__master__' || item.data.toRole === '__master__'),
      ).length,
    });
  });

  app.post('/api/company/sessions', async (c) => {
    const body = await parseJsonBody<
      CreateSessionBody & { runtime_kind?: 'company' | 'app_studio'; visual_qa?: boolean }
    >(c);
    if (!body.name || !body.project_ids?.length) {
      return c.json({ error: 'name and project_ids required' }, 400);
    }
    if (body.allowed_models?.length) {
      const error = validateAllowedModels(body.allowed_models, body);
      if (error) return c.json({ error }, 400);
    }
    const roleAssignments = resolveRoleProjectBindings(
      body.visual_qa === true || (body.runtime_kind === 'app_studio' && body.visual_qa === undefined)
        ? (body.role_assignments ?? []).map(withDefaultQaSkill) : (body.role_assignments ?? []),
      body.project_ids.flatMap((projectId) => {
        const project = deps.db.getProject(projectId);
        return project
          ? [{
              id: project.id,
              name: project.name,
              root_path: project.root_path,
              label: body.project_labels?.[projectId] ?? null,
            }]
          : [];
      }),
    );
    const config = {
      visual_qa: body.visual_qa === true,
      master_provider: body.master_provider,
      master_model: body.master_model,
      role_assignments: roleAssignments,
      ...(body.qa_executor === 'preview' || body.qa_executor === 'playwright' ? { qa_executor: body.qa_executor } : {}),
      ...(body.allowed_models?.length
        ? { allowed_models: body.allowed_models }
        : {}),
      ...(body.master_broadcast_subscribe === true
        ? { master_broadcast_subscribe: true }
        : {}),
      ...(body.operational_rules?.trim()
        ? { operational_rules: body.operational_rules.trim() }
        : {}),
    };
    const input: CreateCompanyFileSessionInput = {
      name: body.name,
      project_ids: body.project_ids,
      project_labels: body.project_labels,
      template_id: body.template_id,
      config_json: JSON.stringify(config),
      runtime_kind: body.runtime_kind ?? 'company',
    };
    try {
      const created = await sessions.createCompanySession(input);
      return c.json(await enrichedFull(deps, created.id), 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not registered|does not exist/i.test(message) ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.patch('/api/company/sessions/:id', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const body = await parseJsonBody<{ name: string }>(c);
    if (!body.name?.trim()) {
      return c.json({ error: 'name is required' }, 400);
    }
    if (!await sessions.getCompanySession(id)) return notFound(c);
    const session = await sessions.renameCompanySession(id, body.name);
    return c.json({ session });
  });

  app.patch('/api/company/sessions/:id/config', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const current = await sessions.getCompanySession(id);
    if (!current) return notFound(c);
    if (current.runtime_kind === 'app_studio') {
      return c.json({
        error: 'App Studio owns this team configuration.',
        code: 'APP_STUDIO_CONTROL_PLANE_OWNED',
        runtime_kind: 'app_studio',
      }, 409);
    }
    const patch = await parseJsonBody<Record<string, unknown>>(c);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return c.json({ error: 'Expected a configuration object.' }, 400);
    const autonomy = 'autonomy' in patch ? sanitizeAutonomyPatch(patch.autonomy) : null;
    if (autonomy && !autonomy.ok) return c.json({ error: autonomy.error }, 400);
    return withSessionLock(id, async () => {
      const session = await sessions.updateCompanySessionConfig(id, (raw) => {
        let previous: Record<string, unknown>;
        try { previous = JSON.parse(raw) ?? {}; } catch { previous = {}; }
        const next = { ...previous, ...patch };
        if (autonomy?.ok) next.autonomy = mergeAutonomyPatch(previous.autonomy, autonomy.patch);
        return JSON.stringify(next);
      });
      return c.json({ session, receipt: notifyCompanySettingsChanged(id, Object.keys(patch)) });
    });
  });

  // The full Company router installs the richer cleanup-aware delete route
  // from session-delete.ts. Keeping this opt-out handler makes this lifecycle
  // module usable on its own (CLI/tests/minimal hosts) while still preserving
  // same-volume, recoverable bundle deletion.
  if (options.includeDelete !== false) {
    app.delete('/api/company/sessions/:id', async (c) => {
      const id = parseCompanySessionIdParam(c);
      const deleted = await sessions.deleteCompanySession(id);
      return deleted
        ? c.json({ ok: true, recoverable: true })
        : notFound(c);
    });
  }
}
