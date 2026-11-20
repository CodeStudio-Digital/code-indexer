import type { HttpRouter } from '@mcp/shared/http/router.js';
import { withDefaultQaSkill } from '@mcp/company-contracts/qa-defaults.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';
import { getCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
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
  return {
    ...full,
    ...runtimeEnvelope(full.session),
    projects: full.projects.map((link) => {
      const project = deps.db.getProject(link.project_id);
      return {
        ...link,
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

  app.get('/api/company/sessions', async (c) => {
    const status = c.req.query('status');
    const rows = await sessions.listCompanySessions(
      status ? { status } : {},
    );
    return c.json(rows.map((row) => ({ ...row, ...runtimeEnvelope(row) })));
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
    const rows = all.filter(row => !row.parent_session_id && !row.archived_at).map(row => {
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
      CreateSessionBody & { runtime_kind?: 'company' | 'app_studio' }
    >(c);
    if (!body.name || !body.project_ids?.length) {
      return c.json({ error: 'name and project_ids required' }, 400);
    }
    if (body.allowed_models?.length) {
      const error = validateAllowedModels(body.allowed_models, body);
      if (error) return c.json({ error }, 400);
    }
    const roleAssignments = resolveRoleProjectBindings(
      (body.role_assignments ?? []).map(withDefaultQaSkill),
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
    let previous: Record<string, unknown>;
    try {
      previous = JSON.parse(current.config_json) as Record<string, unknown>;
    } catch {
      previous = {};
    }
    const session = await sessions.updateCompanySessionConfig(
      id,
      JSON.stringify({ ...previous, ...patch }),
    );
    return c.json({ session });
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
