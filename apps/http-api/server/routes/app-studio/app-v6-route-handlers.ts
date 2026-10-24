import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountAppStudioTeamConfigRoutes } from './team-routes.js';
import { notFound, parseJsonBody, parseSessionIdParam } from '../_helpers.js';
import { stopCompanySessionRuntime } from '../company/session-delete.js';
import { parseAppPlan } from '@mcp/app-studio/plan/types.js';
import { auditAppPlan } from '@mcp/app-studio/plan/fitness.js';
import { evictCompanyOrchestrator, getOrSpawnCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import { dispatchReadyAppWork } from '@mcp/company/tools/app-studio/company-dispatch.js';
import { isUuid } from '@mcp/session-storage';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import { abortCompanyRuntime } from '../company/runtime-lifecycle.js';
import { streamSSE } from 'hono/streaming';
import { getAppTeamSession } from '@mcp/api-handlers/app-studio/app-team-session.js';
import { appState, workFromPlan } from './app-v6-state.js';

export function mountAppStudioV6AppRoutes(app: Hono, deps: ServerDeps): void {
  mountAppStudioTeamConfigRoutes(app, deps);
  app.get('/api/app-studio/apps', async (c) => {
    const sessions = await deps.appStudioStore.listSessions();
    return c.json({
      apps: await Promise.all(
        sessions.map((session) => appState(deps, session.id)),
      ),
    });
  });

  app.get('/api/app-studio/apps/:id', async (c) => {
    const state = await appState(deps, parseSessionIdParam(c), {
      includeRecentEvents: true,
    });
    return state ? c.json(state) : notFound(c, 'App not found');
  });

  app.delete('/api/app-studio/apps/:id', async (c) => {
    const id = parseSessionIdParam(c);
    const session = await deps.appStudioStore.getSession(id);
    if (!session) return notFound(c, 'App not found');
    const companySessionId = session.company_session_id;
    if (companySessionId) await stopCompanySessionRuntime(companySessionId);
    await deps.appStudioStore.deleteSession(id);
    if (companySessionId) {
      await deps.operationalSessionFiles.deleteCompanySession(companySessionId);
    }
    try { deps.db.updateProject(session.project_id, { builder_json: null }); } catch { /* project may be gone */ }
    return c.json({ ok: true, project_preserved: true });
  });

  app.get('/api/app-studio/apps/:id/plan', async (c) => {
    const id = parseSessionIdParam(c);
    if (!(await deps.appStudioStore.getSession(id))) {
      return notFound(c, 'App not found');
    }
    const state = (await appState(deps, id))!;
    const history = await deps.appStudioStore.listPlanRevisions(id);
    return c.json({ revision: state.plan_revision, history: history.map((item) => ({
      id: item.id, revision_number: item.revision_number, status: item.status,
      created_by: item.created_by, created_at: item.created_at, approved_at: item.approved_at,
    })) });
  });

  app.put('/api/app-studio/apps/:id/plan', async (c) => {
    const id = parseSessionIdParam(c);
    if (!(await deps.appStudioStore.getSession(id))) {
      return notFound(c, 'App not found');
    }
    const body = await parseJsonBody<{ plan: unknown; expected_revision_number: number; created_by: string }>(c);
    const plan = parseAppPlan(body.plan);
    if (!plan) return c.json({ error: 'A valid AppPlanV1 is required.' }, 400);
    const fitness = auditAppPlan(plan);
    try {
      const revision = await deps.appStudioStore.savePlanRevision({
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
    const id = parseSessionIdParam(c);
    const session = await deps.appStudioStore.getSession(id);
    if (!session) return notFound(c, 'App not found');
    const body = await parseJsonBody<{
      action: string;
      decision_id: string;
      answer: string;
    }>(c);
    if (body.action === 'approve_plan_and_build') {
      const revision = await deps.appStudioStore.getLatestPlanRevision(id);
      const plan = parseAppPlan(revision?.plan_json ?? null);
      if (!revision || !plan) return c.json({ error: 'The App has no valid plan.' }, 409);
      const fitness = auditAppPlan(plan);
      if (fitness.status !== 'ready') return c.json({ error: 'The plan is not ready.', fitness }, 409);
      try {
        const approved = await deps.appStudioStore.approvePlanRevision(id, revision.id);
        const currentRevisionWork = (await deps.appStudioStore.listWorkItems(id))
          .filter((item) => item.plan_revision_id === approved.id);
        if (currentRevisionWork.length === 0) {
          await deps.appStudioStore.upsertWorkItems(
            workFromPlan(id, approved.id, plan),
          );
        }
        await deps.appStudioStore.refreshReadyWorkItems(id);
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
              await deps.appStudioStore.appendEvent(
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
            await deps.appStudioStore.appendEvent(
              id,
              'build.scheduler_resume_failed',
              'app',
              String(id),
              JSON.stringify({ error: 'App team unavailable' }),
            );
          } catch { /* Approval remains authoritative. */ }
        }
        return c.json({
          ...(await appState(deps, id, { includeRecentEvents: true })),
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
            ...(await appState(deps, id, { includeRecentEvents: true })),
            dispatch_results: dispatchResults,
            error:
              'One or more specialist dispatches have an unknown outcome. ' +
              'Their claimed attempts were fenced and were not spawned again.',
            code: 'OUTCOME_UNKNOWN',
          }, 500);
        }
        return c.json({
          ...(await appState(deps, id, { includeRecentEvents: true })),
          dispatch_results: dispatchResults,
        });
      } catch (error) {
        return c.json({ error: (error as Error).message }, 409);
      }
    }
    if (body.action === 'answer_decision') {
      if (
        typeof body.decision_id !== 'string' ||
        !isUuid(body.decision_id) ||
        typeof body.answer !== 'string' ||
        !body.answer.trim()
      ) {
        return c.json({ error: 'decision_id and answer are required.' }, 400);
      }
      const decision = await deps.appStudioStore.resolveDecision(
        id,
        body.decision_id,
        body.answer.trim(),
      );
      const coordinationWarning = 'Decision saved, but App coordination could not be resumed.';
      if (!session.company_session_id) {
        try {
          await deps.appStudioStore.appendEvent(
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
            await deps.appStudioStore.appendEvent(
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
          await deps.appStudioStore.appendEvent(
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
      const revision = await deps.appStudioStore.getLatestPlanRevision(id);
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
        await deps.operationalSessionFiles.updateCompanySessionStatus(
          session.company_session_id,
          'paused',
        );
      }
      await deps.appStudioStore.appendEvent(id, 'build.paused', 'app', String(id));
      return c.json({ ok: true });
    }
    if (body.action === 'resume') {
      if (!session.company_session_id) return c.json({ error: 'The App team is unavailable.' }, 409);
      const revision = await deps.appStudioStore.getLatestPlanRevision(id);
      const hasOpenDecision = (
        await deps.appStudioStore.listDecisions(id)
      ).some((decision) => decision.status === 'open');
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
      await deps.appStudioStore.appendEvent(
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
      for (const item of await deps.appStudioStore.listWorkItems(id)) {
        if (!['done', 'cancelled'].includes(item.status)) {
          await deps.appStudioStore.setWorkItemStatus(
            id,
            item.id,
            'cancelled',
          );
        }
      }
      await deps.appStudioStore.appendEvent(
        id,
        'build.cancelled',
        'app',
        String(id),
      );
      return c.json({ ok: true });
    }
    return c.json({ error: 'Unknown App action.' }, 400);
  });

  app.get('/api/app-studio/apps/:id/events', async (c) => {
    const id = parseSessionIdParam(c);
    if (!(await deps.appStudioStore.getSession(id))) {
      return notFound(c, 'App not found');
    }
    let cursor = Number(c.req.query('after') ?? c.req.header('last-event-id') ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      while (!stream.closed && !c.req.raw.signal.aborted) {
        const events = await deps.appStudioStore.listEvents(id, cursor);
        for (const event of events) {
          cursor = event.seq;
          await stream.writeSSE({
            id: String(event.seq),
            event: event.kind,
            data: event.payload_json,
          });
        }
        if (events.length === 0) await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ cursor }) });
        await stream.sleep(1_500);
      }
    });
  });

  app.get('/api/app-studio/apps/:id/team', async (c) => {
    const id = parseSessionIdParam(c);
    const team = await getAppTeamSession(deps, id);
    return team ? c.json({ team, agents_url: `/agents/${team.company_session_id}` }) : notFound(c, 'App team not found');
  });

}
