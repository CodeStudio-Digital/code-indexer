import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { auditAppPlan } from '@mcp/app-studio/plan/fitness.js';
import { appWorkspaceFingerprint } from '@mcp/app-studio/plan/evidence.js';
import { parseAppPlan, type AppFitnessReport, type AppPlanV1 } from '@mcp/app-studio/plan/types.js';
import type { AppStudioWorkItem, UpsertAppStudioWorkItemInput } from '@mcp/store/app-studio-store.js';
import { getAppTeamSession } from '@mcp/api-handlers/app-studio/app-team-session.js';
import { getOrSpawnCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import { abortCompanyRuntime } from '../company/runtime-lifecycle.js';
import { stopCompanySessionRuntime } from '../company/session-delete.js';
import { notFound, parseIdParam, parseJsonBody } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';
import { mountAppStudioTeamConfigRoutes } from './team-routes.js';

type AppStage = 'planning' | 'building' | 'reviewing' | 'ready' | 'live';

function json<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function workView(row: AppStudioWorkItem) {
  const { depends_on_json, source_ids_json, acceptance_json, evidence_json, file_scope_json, ...plain } = row;
  return {
    ...plain,
    depends_on: json<string[]>(depends_on_json, []),
    source_ids: json<string[]>(source_ids_json, []),
    acceptance: json<string[]>(acceptance_json, []),
    evidence: json<Array<Record<string, unknown>>>(evidence_json, []),
    file_scope: json<string[]>(file_scope_json, []),
  };
}

function deriveStage(args: {
  approved: boolean;
  fitness: AppFitnessReport | null;
  work: AppStudioWorkItem[];
  openDecisions: number;
  live: boolean;
  evidenceCurrent: boolean;
}): AppStage {
  if (args.live) return 'live';
  if (!args.approved) return args.openDecisions > 0 || args.fitness?.status === 'needs_decision' ? 'reviewing' : 'planning';
  if (args.openDecisions > 0 || args.work.some((item) => item.status === 'review' || item.status === 'blocked')) return 'reviewing';
  if (args.work.length > 0 && args.work.every((item) => item.status === 'done')) return args.evidenceCurrent ? 'ready' : 'reviewing';
  return 'building';
}

function appState(deps: ServerDeps, id: number) {
  const session = deps.appStudioStore.getSession(id);
  if (!session) return null;
  const project = deps.db.getProject(session.project_id);
  const builder = json<{ port?: number }>(project?.builder_json, {});
  const revision = deps.appStudioStore.getLatestPlanRevision(id);
  const plan = parseAppPlan(revision?.plan_json ?? null);
  const fitness = json<AppFitnessReport | null>(revision?.fitness_json, null);
  const work = deps.appStudioStore.listWorkItems(id);
  const decisions = deps.appStudioStore.listDecisions(id);
  const deployment = deps.appStudioStore.getLatestDeployment(id);
  const team = getAppTeamSession(deps, id);
  const evidenceCurrent = (() => {
    if (!project?.root_path || !fitness || work.length === 0 || !work.every((item) => item.status === 'done')) return false;
    const workspace = appWorkspaceFingerprint(project.root_path);
    return work.every((item) => json<Array<{ plan_fingerprint?: string; workspace_fingerprint?: string }>>(item.evidence_json, [])
      .some((record) => record.plan_fingerprint === fitness.plan_fingerprint && record.workspace_fingerprint === workspace));
  })();
  return {
    session,
    project: project ? { id: project.id, name: project.name, root_path: project.root_path } : null,
    builder_port: typeof builder.port === 'number' ? builder.port : null,
    stage: deriveStage({
      approved: revision?.status === 'approved',
      fitness,
      work,
      openDecisions: decisions.filter((item) => item.status === 'open').length,
      live: deployment?.status === 'live' && deployment.health_ok === 1,
      evidenceCurrent,
    }),
    plan_revision: revision ? {
      ...revision,
      plan,
      fitness,
      plan_json: undefined,
      fitness_json: undefined,
    } : null,
    plan_history: deps.appStudioStore.listPlanRevisions(id).map((item) => ({
      id: item.id,
      revision_number: item.revision_number,
      status: item.status,
      created_by: item.created_by,
      created_at: item.created_at,
      approved_at: item.approved_at,
    })),
    work_items: work.map(workView),
    decisions: decisions.map(({ options_json, blocked_work_item_ids_json, ...decision }) => ({
      ...decision,
      options: json<unknown[]>(options_json, []),
      blocked_work_item_ids: json<string[]>(blocked_work_item_ids_json, []),
    })),
    deployment,
    evidence_current: evidenceCurrent,
    team,
    master_session_id: team?.master_session_id ?? null,
  };
}

function workFromPlan(appSessionId: number, revisionId: number, plan: AppPlanV1): UpsertAppStudioWorkItemInput[] {
  const items: UpsertAppStudioWorkItemInput[] = [];
  for (const [index, slice] of plan.delivery.slices.entries()) {
    const tests = plan.delivery.tests.filter((test) => slice.test_ids.includes(test.id));
    const implementId = `slice:${slice.id}:implement`;
    items.push({
      app_session_id: appSessionId,
      id: implementId,
      plan_revision_id: revisionId,
      slice_id: slice.id,
      title: `Construir ${slice.name}`,
      outcome: `Entregar o slice '${slice.name}' do plano aprovado.`,
      kind: 'implement',
      owner_role: 'fullstack',
      priority: 100 - index,
      sort_order: index * 2,
      status: 'backlog',
      depends_on_json: JSON.stringify(slice.depends_on.map((id) => `slice:${id}:verify`)),
      source_ids_json: JSON.stringify(slice.capability_ids),
      acceptance_json: JSON.stringify(tests.map((test) => `${test.title}: ${test.expected}`)),
    });
    items.push({
      app_session_id: appSessionId,
      id: `slice:${slice.id}:verify`,
      plan_revision_id: revisionId,
      slice_id: slice.id,
      title: `Revisar ${slice.name}`,
      outcome: `Provar que o slice '${slice.name}' atende à revisão aprovada.`,
      kind: 'verify',
      owner_role: 'qa',
      priority: 90 - index,
      sort_order: index * 2 + 1,
      status: 'backlog',
      depends_on_json: JSON.stringify([implementId]),
      source_ids_json: JSON.stringify([...slice.capability_ids, ...slice.test_ids]),
      acceptance_json: JSON.stringify(tests.map((test) => `${test.title}: ${test.expected}`)),
    });
  }
  return items;
}

export function mountAppStudioV6AppRoutes(app: Hono, deps: ServerDeps): void {
  mountAppStudioTeamConfigRoutes(app, deps);
  app.get('/api/app-studio/apps', (c) => c.json({
    apps: deps.appStudioStore.listSessions().map((session) => appState(deps, session.id)),
  }));

  app.get('/api/app-studio/apps/:id', (c) => {
    const state = appState(deps, parseIdParam(c));
    return state ? c.json(state) : notFound(c, 'App not found');
  });

  app.delete('/api/app-studio/apps/:id', async (c) => {
    const id = parseIdParam(c);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c, 'App not found');
    const companySessionId = session.company_session_id;
    if (companySessionId) await stopCompanySessionRuntime(companySessionId);
    deps.appStudioStore.deleteSession(id);
    if (companySessionId) deps.companyStore.deleteCompanySession(companySessionId);
    try { deps.db.updateProject(session.project_id, { builder_json: null }); } catch { /* project may be gone */ }
    return c.json({ ok: true, project_preserved: true });
  });

  app.get('/api/app-studio/apps/:id/plan', (c) => {
    const id = parseIdParam(c);
    if (!deps.appStudioStore.getSession(id)) return notFound(c, 'App not found');
    const state = appState(deps, id)!;
    return c.json({ revision: state.plan_revision, history: deps.appStudioStore.listPlanRevisions(id).map((item) => ({
      id: item.id, revision_number: item.revision_number, status: item.status,
      created_by: item.created_by, created_at: item.created_at, approved_at: item.approved_at,
    })) });
  });

  app.put('/api/app-studio/apps/:id/plan', async (c) => {
    const id = parseIdParam(c);
    if (!deps.appStudioStore.getSession(id)) return notFound(c, 'App not found');
    const body = await parseJsonBody<{ plan: unknown; expected_revision_number: number; created_by: string }>(c);
    const plan = parseAppPlan(body.plan);
    if (!plan) return c.json({ error: 'A valid AppPlanV1 is required.' }, 400);
    const fitness = auditAppPlan(plan);
    try {
      const revision = deps.appStudioStore.savePlanRevision({
        app_session_id: id,
        plan,
        fitness,
        expected_revision_number: typeof body.expected_revision_number === 'number' ? body.expected_revision_number : null,
        created_by: typeof body.created_by === 'string' ? body.created_by : 'app_orchestrator',
      });
      return c.json({ revision: { ...revision, plan, fitness, plan_json: undefined, fitness_json: undefined } });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 409);
    }
  });

  app.post('/api/app-studio/apps/:id/actions', async (c) => {
    const id = parseIdParam(c);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c, 'App not found');
    const body = await parseJsonBody<{ action: string; decision_id: number; answer: string }>(c);
    if (body.action === 'approve_plan_and_build') {
      const revision = deps.appStudioStore.getLatestPlanRevision(id);
      const plan = parseAppPlan(revision?.plan_json ?? null);
      if (!revision || !plan) return c.json({ error: 'The App has no valid plan.' }, 409);
      const fitness = auditAppPlan(plan);
      if (fitness.status !== 'ready') return c.json({ error: 'The plan is not ready.', fitness }, 409);
      try {
        const approved = deps.appStudioStore.approvePlanRevision(id, revision.id);
        deps.appStudioStore.upsertWorkItems(workFromPlan(id, approved.id, plan));
        deps.appStudioStore.refreshReadyWorkItems(id);
        if (session.company_session_id) {
          void getOrSpawnCompanyOrchestrator(session.company_session_id)
            .then(({ orchestrator }) => orchestrator.sendMessageToMaster(
              '[App Studio] O plano foi aprovado. Revise os cards da revisão atual e despache somente o trabalho pronto.',
            ))
            .catch(() => undefined);
        }
        return c.json(appState(deps, id));
      } catch (error) {
        return c.json({ error: (error as Error).message }, 409);
      }
    }
    if (body.action === 'answer_decision') {
      if (typeof body.decision_id !== 'number' || typeof body.answer !== 'string' || !body.answer.trim()) {
        return c.json({ error: 'decision_id and answer are required.' }, 400);
      }
      return c.json({ decision: deps.appStudioStore.resolveDecision(id, body.decision_id, body.answer.trim()) });
    }
    if (body.action === 'run_checks') {
      const revision = deps.appStudioStore.getLatestPlanRevision(id);
      const plan = parseAppPlan(revision?.plan_json ?? null);
      return plan ? c.json({ fitness: auditAppPlan(plan) }) : c.json({ error: 'The App has no valid plan.' }, 409);
    }
    if (body.action === 'pause') {
      if (session.company_session_id) {
        abortCompanyRuntime(session.company_session_id);
        deps.companyStore.updateCompanySessionStatus(session.company_session_id, 'paused');
      }
      deps.appStudioStore.appendEvent(id, 'build.paused', 'app', String(id));
      return c.json({ ok: true });
    }
    if (body.action === 'resume') {
      if (!session.company_session_id) return c.json({ error: 'The App team is unavailable.' }, 409);
      const { orchestrator } = await getOrSpawnCompanyOrchestrator(session.company_session_id);
      await orchestrator.sendMessageToMaster('[App Studio] Retome a construção pelos cards prontos da revisão aprovada.');
      deps.appStudioStore.appendEvent(id, 'build.resumed', 'app', String(id));
      return c.json({ ok: true });
    }
    if (body.action === 'cancel') {
      if (session.company_session_id) abortCompanyRuntime(session.company_session_id);
      for (const item of deps.appStudioStore.listWorkItems(id)) {
        if (!['done', 'cancelled'].includes(item.status)) deps.appStudioStore.setWorkItemStatus(id, item.id, 'cancelled');
      }
      deps.appStudioStore.appendEvent(id, 'build.cancelled', 'app', String(id));
      return c.json({ ok: true });
    }
    return c.json({ error: 'Unknown App action.' }, 400);
  });

  app.get('/api/app-studio/apps/:id/events', (c) => {
    const id = parseIdParam(c);
    if (!deps.appStudioStore.getSession(id)) return notFound(c, 'App not found');
    let cursor = Number(c.req.query('after') ?? c.req.header('last-event-id') ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      while (!stream.closed && !c.req.raw.signal.aborted) {
        const events = deps.appStudioStore.listEvents(id, cursor);
        for (const event of events) {
          cursor = event.id;
          await stream.writeSSE({ id: String(event.id), event: event.kind, data: event.payload_json });
        }
        if (events.length === 0) await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ cursor }) });
        await stream.sleep(1_500);
      }
    });
  });

  app.get('/api/app-studio/apps/:id/team', (c) => {
    const id = parseIdParam(c);
    const team = getAppTeamSession(deps, id);
    return team ? c.json({ team, agents_url: `/agents/${team.company_session_id}` }) : notFound(c, 'App team not found');
  });

}
