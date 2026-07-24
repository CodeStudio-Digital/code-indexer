import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { auditAppPlan } from '@mcp/app-studio/plan/fitness.js';
import { appWorkspaceFingerprint } from '@mcp/app-studio/plan/evidence.js';
import { parseAppPlan, type AppFitnessReport, type AppPlanV1 } from '@mcp/app-studio/plan/types.js';
import type { AppStudioWorkItem, UpsertAppStudioWorkItemInput } from '@mcp/store/app-studio-store.js';
import { getAppTeamSession } from '@mcp/api-handlers/app-studio/app-team-session.js';
import { dispatchReadyAppWork } from '@mcp/company/tools/app-studio/company-dispatch.js';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import {
  evictCompanyOrchestrator,
  getOrSpawnCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
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

function recentEventViews(deps: ServerDeps, id: number, limit = 50) {
  const recent: ReturnType<ServerDeps['appStudioStore']['listEvents']> = [];
  let cursor = 0;
  for (;;) {
    const batch = deps.appStudioStore.listEvents(id, cursor);
    if (batch.length === 0) break;
    recent.push(...batch);
    if (recent.length > limit) recent.splice(0, recent.length - limit);
    const nextCursor = batch[batch.length - 1]!.id;
    if (nextCursor <= cursor || batch.length < 250) break;
    cursor = nextCursor;
  }
  return recent.map((event) => ({
    id: event.id,
    event_type: event.kind,
    payload: json<unknown>(event.payload_json, {}),
    created_at: event.created_at,
  }));
}

function appState(deps: ServerDeps, id: number, options: { includeRecentEvents?: boolean } = {}) {
  const session = deps.appStudioStore.getSession(id);
  if (!session) return null;
  const project = deps.db.getProject(session.project_id);
  const builder = json<{ port?: number }>(project?.builder_json, {});
  const revision = deps.appStudioStore.getLatestPlanRevision(id);
  const plan = parseAppPlan(revision?.plan_json ?? null);
  const fitness = json<AppFitnessReport | null>(revision?.fitness_json, null);
  const work = deps.appStudioStore.listWorkItems(id);
  const currentWork = work.filter((item) => (
    item.plan_revision_id === revision?.id && !['cancelled', 'stale'].includes(item.status)
  ));
  const workRuns = deps.appStudioStore.listWorkItemRuns(id, { limit: 250 });
  const workRunsByItem = new Map<string, typeof workRuns>();
  for (const run of workRuns) {
    const attempts = workRunsByItem.get(run.work_item_id) ?? [];
    if (attempts.length < 3) attempts.push(run);
    workRunsByItem.set(run.work_item_id, attempts);
  }
  const decisions = deps.appStudioStore.listDecisions(id);
  const deployment = deps.appStudioStore.getLatestDeployment(id);
  const team = getAppTeamSession(deps, id);
  const evidenceCurrent = (() => {
    if (!project?.root_path || !fitness || currentWork.length === 0 || !currentWork.every((item) => item.status === 'done')) return false;
    const workspace = appWorkspaceFingerprint(project.root_path);
    return currentWork.every((item) => json<Array<{ plan_fingerprint?: string; workspace_fingerprint?: string }>>(item.evidence_json, [])
      .some((record) => record.plan_fingerprint === fitness.plan_fingerprint && record.workspace_fingerprint === workspace));
  })();
  return {
    session,
    project: project ? { id: project.id, name: project.name, root_path: project.root_path } : null,
    builder_port: typeof builder.port === 'number' ? builder.port : null,
    stage: deriveStage({
      approved: revision?.status === 'approved',
      fitness,
      work: currentWork,
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
    work_items: work.map((item) => {
      const attempts = workRunsByItem.get(item.id) ?? [];
      return {
        ...workView(item),
        latest_attempt: attempts[0] ?? null,
        active_attempt: attempts.find((attempt) => (
          ['claimed', 'running', 'waiting', 'paused'].includes(attempt.status)
        )) ?? null,
        attempts,
      };
    }),
    decisions: decisions.map(({ options_json, blocked_work_item_ids_json, ...decision }) => ({
      ...decision,
      options: json<unknown[]>(options_json, []),
      blocked_work_item_ids: json<string[]>(blocked_work_item_ids_json, []),
    })),
    deployment,
    evidence_current: evidenceCurrent,
    team,
    master_session_id: team?.master_session_id ?? null,
    ...(options.includeRecentEvents ? { recent_events: recentEventViews(deps, id) } : {}),
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
    const state = appState(deps, parseIdParam(c), { includeRecentEvents: true });
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
        const currentRevisionWork = deps.appStudioStore.listWorkItems(id)
          .filter((item) => item.plan_revision_id === approved.id);
        if (currentRevisionWork.length === 0) {
          deps.appStudioStore.upsertWorkItems(workFromPlan(id, approved.id, plan));
        }
        deps.appStudioStore.refreshReadyWorkItems(id);
        const schedulerWarning = 'Plan approved, but the App scheduler could not be resumed.';
        let schedulerResumed = false;
        let warning: string | undefined;
        if (session.company_session_id) {
          try {
            await getOrSpawnCompanyOrchestrator(session.company_session_id);
            schedulerResumed = true;
          } catch (error) {
            warning = schedulerWarning;
            try {
              deps.appStudioStore.appendEvent(
                id,
                'build.scheduler_resume_failed',
                'app',
                String(id),
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            } catch { /* Approval remains authoritative. */ }
          }
        } else {
          warning = schedulerWarning;
          try {
            deps.appStudioStore.appendEvent(
              id,
              'build.scheduler_resume_failed',
              'app',
              String(id),
              JSON.stringify({ error: 'App team unavailable' }),
            );
          } catch { /* Approval remains authoritative. */ }
        }
        return c.json({
          ...appState(deps, id, { includeRecentEvents: true }),
          scheduler_resumed: schedulerResumed,
          ...(warning ? { warning } : {}),
        });
      } catch (error) {
        return c.json({ error: (error as Error).message }, 409);
      }
    }
    if (body.action === 'dispatch_ready_work') {
      if (!session.company_session_id) return c.json({ error: 'The App team is unavailable.' }, 409);
      try {
        const { orchestrator } = await getOrSpawnCompanyOrchestrator(session.company_session_id);
        const dispatchResults = await dispatchReadyAppWork({
          store: deps.appStudioStore,
          session,
          host: orchestrator,
          source: 'manual',
          maxItems: 2,
        });
        if (dispatchResults.some((result) => result.code === 'OUTCOME_UNKNOWN')) {
          await evictCompanyOrchestrator(session.company_session_id);
          return c.json({
            ...appState(deps, id, { includeRecentEvents: true }),
            dispatch_results: dispatchResults,
            error:
              'One or more specialist dispatches have an unknown outcome. ' +
              'Their claimed attempts were fenced and were not spawned again.',
            code: 'OUTCOME_UNKNOWN',
          }, 500);
        }
        return c.json({
          ...appState(deps, id, { includeRecentEvents: true }),
          dispatch_results: dispatchResults,
        });
      } catch (error) {
        return c.json({ error: (error as Error).message }, 409);
      }
    }
    if (body.action === 'answer_decision') {
      if (typeof body.decision_id !== 'number' || typeof body.answer !== 'string' || !body.answer.trim()) {
        return c.json({ error: 'decision_id and answer are required.' }, 400);
      }
      const decision = deps.appStudioStore.resolveDecision(id, body.decision_id, body.answer.trim());
      const coordinationWarning = 'Decision saved, but App coordination could not be resumed.';
      if (!session.company_session_id) {
        try {
          deps.appStudioStore.appendEvent(
            id,
            'decision.coordination_failed',
            'decision',
            String(decision.id),
            JSON.stringify({ error: 'App team unavailable' }),
          );
        } catch { /* The durable decision remains authoritative. */ }
        return c.json({ decision, coordination_resumed: false, warning: coordinationWarning });
      }
      try {
        const { orchestrator } = await getOrSpawnCompanyOrchestrator(session.company_session_id);
        const delivery = await orchestrator.sendMessageToMaster(
          `[App Studio] Decisão respondida. Pergunta: ${decision.question}\n` +
          `Resposta: ${decision.answer ?? body.answer.trim()}\n` +
          'Atualize o plano e os cards afetados conforme a resposta. Não despache trabalho; o scheduler é o único dispatcher automático.',
        );
        if (!delivery.ok) {
          const error = delivery.pending === 'interactive_wait'
            ? 'Master is waiting for another interactive answer'
            : 'Master did not accept the coordination message';
          const code = delivery.pending === 'interactive_wait'
            ? 'INTERACTION_PENDING'
            : 'MASTER_MESSAGE_NOT_ACCEPTED';
          try {
            deps.appStudioStore.appendEvent(
              id,
              'decision.coordination_failed',
              'decision',
              String(decision.id),
              JSON.stringify({
                error,
                code,
              }),
            );
          } catch { /* The durable decision remains authoritative. */ }
          return c.json({
            decision,
            coordination_resumed: false,
            warning: coordinationWarning,
            code,
          });
        }
        return c.json({ decision, coordination_resumed: true });
      } catch (error) {
        const outcomeUnknown = isMutationOutcomeUnknownError(error);
        if (outcomeUnknown) {
          await evictCompanyOrchestrator(session.company_session_id);
        }
        try {
          deps.appStudioStore.appendEvent(
            id,
            'decision.coordination_failed',
            'decision',
            String(decision.id),
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              ...(outcomeUnknown ? { code: 'OUTCOME_UNKNOWN' } : {}),
            }),
          );
        } catch { /* The durable decision remains authoritative. */ }
        return c.json({
          decision,
          coordination_resumed: false,
          warning: outcomeUnknown
            ? 'Decision saved, but App coordination delivery has an unknown outcome and was not replayed.'
            : coordinationWarning,
          code: outcomeUnknown ? 'OUTCOME_UNKNOWN' : 'MASTER_COORDINATION_FAILED',
        });
      }
    }
    if (body.action === 'run_checks') {
      const revision = deps.appStudioStore.getLatestPlanRevision(id);
      const plan = parseAppPlan(revision?.plan_json ?? null);
      return plan ? c.json({ fitness: auditAppPlan(plan) }) : c.json({ error: 'The App has no valid plan.' }, 409);
    }
    if (body.action === 'pause') {
      if (session.company_session_id) {
        const abortResult = await abortCompanyRuntime(session.company_session_id);
        if (!abortResult.ok && abortResult.reason === 'outcome_unknown') {
          return c.json({
            error: abortResult.error,
            code: abortResult.code,
          }, 500);
        }
        deps.companyStore.updateCompanySessionStatus(session.company_session_id, 'paused');
      }
      deps.appStudioStore.appendEvent(id, 'build.paused', 'app', String(id));
      return c.json({ ok: true });
    }
    if (body.action === 'resume') {
      if (!session.company_session_id) return c.json({ error: 'The App team is unavailable.' }, 409);
      const revision = deps.appStudioStore.getLatestPlanRevision(id);
      const hasOpenDecision = deps.appStudioStore.listDecisions(id).some((decision) => decision.status === 'open');
      const needsMasterCoordination = revision?.status !== 'approved' || hasOpenDecision;
      try {
        const { orchestrator } = await getOrSpawnCompanyOrchestrator(session.company_session_id);
        if (needsMasterCoordination) {
          const delivery = await orchestrator.sendMessageToMaster(
            '[App Studio] Retome a coordenação do plano e das decisões abertas. O scheduler cuida do despacho automático.',
          );
          if (!delivery.ok) {
            const interactionPending = delivery.pending === 'interactive_wait';
            return c.json({
              error: interactionPending
                ? 'Master is waiting for an interactive answer'
                : 'Master did not accept the coordination message',
              code: interactionPending
                ? 'INTERACTION_PENDING'
                : 'MASTER_MESSAGE_NOT_ACCEPTED',
            }, interactionPending ? 409 : 503);
          }
        }
      } catch (error) {
        const outcomeUnknown = isMutationOutcomeUnknownError(error);
        if (outcomeUnknown) {
          await evictCompanyOrchestrator(session.company_session_id);
        }
        return c.json({
          error: error instanceof Error ? error.message : String(error),
          code: outcomeUnknown ? 'OUTCOME_UNKNOWN' : 'MASTER_COORDINATION_FAILED',
        }, outcomeUnknown ? 500 : 502);
      }
      deps.appStudioStore.appendEvent(
        id,
        'build.resumed',
        'app',
        String(id),
        JSON.stringify({ mode: needsMasterCoordination ? 'master_coordination' : 'scheduler' }),
      );
      return c.json({ ok: true });
    }
    if (body.action === 'cancel') {
      if (session.company_session_id) {
        const abortResult = await abortCompanyRuntime(session.company_session_id);
        if (!abortResult.ok && abortResult.reason === 'outcome_unknown') {
          return c.json({
            error: abortResult.error,
            code: abortResult.code,
          }, 500);
        }
      }
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
