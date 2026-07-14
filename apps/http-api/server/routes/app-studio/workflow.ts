import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { dependentWorkItemIds, staleWorkItemsBySources } from '@mcp/app-studio/workflow/scheduler.js';
import { auditAppReleaseReadiness } from '@mcp/app-studio/workflow/audit.js';
import { parseAppProductModel } from '@mcp/app-studio/product/types.js';
import { upgradeAppSpecToV2 } from '@mcp/app-studio/spec/stable-ids.js';
import type { UpsertAppStudioWorkItemInput } from '@mcp/store/app-studio-store.js';
import { parseIdParam, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';
import { getAppWorkflowView } from './workflow-service.js';

function wakeCoordinator(app: Hono, coordinatorId: number | null, content: string): void {
  if (!coordinatorId) return;
  void (async () => {
    const inject = await app.request(new Request(`http://app.local/api/coder/sessions/${coordinatorId}/inject`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, interject: true }),
    }));
    const result = await inject.json().catch(() => ({})) as { injected?: boolean; noActiveRun?: boolean };
    if (result.injected) return;
    const response = await app.request(new Request(`http://app.local/api/coder/sessions/${coordinatorId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, agent: 'app_orchestrator' }),
    }));
    await response.text().catch(() => '');
  })().catch(() => undefined);
}

export function mountAppStudioWorkflowRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/app-studio/sessions/:id/workflow', (c) => {
    const id = parseIdParam(c);
    if (!deps.appStudioStore.getSession(id)) return notFound(c);
    const workflow = getAppWorkflowView(deps, id);
    if (!workflow) return c.json({ error: 'Unable to initialize App Studio workflow.' }, 409);
    return c.json({ workflow });
  });

  app.post('/api/app-studio/sessions/:id/approvals/:approvalId/resolve', async (c) => {
    const id = parseIdParam(c);
    if (!deps.appStudioStore.getSession(id)) return notFound(c);
    const approvalId = Number(c.req.param('approvalId'));
    const body = await c.req.json<{ decision?: 'approve' | 'request_changes'; feedback?: string; source_ids?: string[] }>();
    if (body.decision !== 'approve' && body.decision !== 'request_changes') return c.json({ error: 'decision must be approve or request_changes.' }, 400);
    if (body.decision === 'request_changes' && !body.feedback?.trim()) return c.json({ error: 'feedback is required when requesting changes.' }, 400);
    const before = deps.appStudioStore.listApprovals(id).find((item) => item.id === approvalId);
    if (!before) return notFound(c, 'Approval not found');
    if (before.status !== 'pending') {
      const priorDecision = before.status === 'approved' ? 'approve' : before.status === 'changes_requested' ? 'request_changes' : null;
      if (!priorDecision || priorDecision !== body.decision) return c.json({ error: `Approval was already resolved as '${before.status}'.` }, 409);
    }
    if (before.status === 'pending' && before.type === 'release' && body.decision === 'approve') {
      const workflow = getAppWorkflowView(deps, id);
      const readiness = auditAppReleaseReadiness(workflow?.work_items ?? [], workflow?.blueprint ?? null);
      if (!readiness.ok) return c.json({ error: `Release is blocked:\n- ${readiness.issues.join('\n- ')}` }, 409);
    }
    const key = c.req.header('idempotency-key') || `approval:${id}:${approvalId}:${body.decision}`;
    // Persist the decision before any artifact mutation or coordinator wake-up.
    // Replays reuse the same event and finish any idempotent side effects.
    const approval = deps.appStudioStore.resolveApproval({ sessionId: id, approvalId, decision: body.decision, feedback: body.feedback, idempotencyKey: key });
    if (body.decision === 'approve' && before.type === 'scope') {
      const bundle = JSON.parse(before.bundle_json || '{}') as { spec_revision_id?: number | null };
      const proposedSpec = bundle.spec_revision_id ? deps.appStudioStore.getSpecRevision(bundle.spec_revision_id) : null;
      const productRevision = deps.appStudioStore.getLatestProductRevision(id);
      const product = parseAppProductModel(productRevision?.product_json);
      const session = deps.appStudioStore.getSession(id)!;
      if (proposedSpec?.status === 'draft') {
        deps.appStudioStore.approveSpecRevision(id, proposedSpec.id);
        const impact = JSON.parse(proposedSpec.impact_json || '{}') as { source_ids?: string[] };
        const workItems = getAppWorkflowView(deps, id)?.work_items ?? [];
        const stale = staleWorkItemsBySources(workItems, impact.source_ids ?? []);
        if (stale.size > 0) deps.appStudioStore.markWorkItemsStale(id, [...stale], 'O Escopo aprovado mudou as fontes ligadas a estes cards.');
        const evolution = deps.appStudioStore.listEvolutions(id).find((item) => item.proposed_revision_id === proposedSpec.id);
        if (evolution) deps.appStudioStore.updateEvolution(evolution.id, { status: 'applied', approved_at: new Date().toISOString(), applied_at: new Date().toISOString() });
      } else if (productRevision?.status === 'draft' && product) {
        deps.appStudioStore.applyProductRevisionToScope({
          sessionId: id,
          revisionId: productRevision.id,
          candidateSpecJson: JSON.stringify(upgradeAppSpecToV2(product.candidate_spec)),
          workflowStateJson: session.pipeline_json!,
        });
      } else {
        deps.appStudioStore.ensureInitialSpecRevision(id, { created_by: 'user', title: 'Escopo aprovado' });
      }
    }
    if (body.decision === 'approve' && before.type === 'blueprint') deps.appStudioStore.approveBlueprintArtifacts(id);
    if (body.decision === 'request_changes') {
      const workItems = getAppWorkflowView(deps, id)?.work_items ?? [];
      const stale = staleWorkItemsBySources(workItems, body.source_ids ?? []);
      if (stale.size > 0) deps.appStudioStore.markWorkItemsStale(id, [...stale], body.feedback!.trim());
      const phase = before.type === 'scope' ? 'define' : before.type === 'blueprint' ? 'blueprint' : 'deliver';
      deps.appStudioStore.upsertWorkItems([{
        id: `change:${approvalId}:${before.bundle_revision + 1}`,
        app_session_id: id,
        phase,
        title: `Aplicar mudanças solicitadas em ${before.type}`,
        outcome: body.feedback!.trim(),
        kind: 'change', owner_profile: 'coordinator', priority: 1, status: 'ready', sort_order: 0,
        source_ids_json: JSON.stringify(body.source_ids ?? []),
        acceptance_json: JSON.stringify([body.feedback!.trim()]),
      }]);
    } else {
      deps.appStudioStore.refreshReadyWorkItems(id);
    }
    const workflow = getAppWorkflowView(deps, id)!;
    wakeCoordinator(app, workflow.coordinator_session_id,
      body.decision === 'approve'
        ? `[App Studio] A aprovação '${before.type}' foi aceita. Releia app_get_workflow e continue pelos cards prontos sem encerrar a sessão.`
        : `[App Studio] Foram solicitadas mudanças em '${before.type}': ${body.feedback!.trim()}. Releia app_get_workflow e trabalhe somente nos cards afetados.`);
    return c.json({ approval, workflow });
  });

  app.patch('/api/app-studio/sessions/:id/work-items/:workItemId', async (c) => {
    const id = parseIdParam(c);
    if (!deps.appStudioStore.getSession(id)) return notFound(c);
    const workItemId = decodeURIComponent(c.req.param('workItemId'));
    const body = await c.req.json<{ action?: 'reorder' | 'pause' | 'resume' | 'cancel' | 'request_changes'; sort_order?: number; feedback?: string }>();
    try {
      if (body.action === 'reorder') {
        if (!Number.isFinite(body.sort_order)) return c.json({ error: 'sort_order is required.' }, 400);
        deps.appStudioStore.reorderWorkItem(id, workItemId, body.sort_order!);
      } else if (body.action === 'pause') {
        deps.appStudioStore.setWorkItemStatus(id, workItemId, 'blocked', { blockedReason: body.feedback?.trim() || 'Pausado pelo usuário.' });
      } else if (body.action === 'resume') {
        const item = deps.appStudioStore.getWorkItem(id, workItemId);
        if (!item) return notFound(c, 'Work item not found');
        if (item.status === 'stale') return c.json({ error: 'A stale card needs a corrective card; it cannot be resumed directly.' }, 409);
        const linkedDecision = deps.appStudioStore.listDecisionRequests(id).find((decision) => {
          if (decision.status !== 'open') return false;
          try { return (JSON.parse(decision.blocked_work_item_ids_json) as string[]).includes(workItemId); } catch { return false; }
        });
        if (linkedDecision) return c.json({ error: `Resolve decision ${linkedDecision.id} before resuming this card.` }, 409);
        deps.appStudioStore.setWorkItemStatus(id, workItemId, 'backlog');
        deps.appStudioStore.refreshReadyWorkItems(id);
      } else if (body.action === 'cancel') {
        deps.appStudioStore.setWorkItemStatus(id, workItemId, 'cancelled');
        deps.appStudioStore.refreshReadyWorkItems(id);
      } else if (body.action === 'request_changes') {
        if (!body.feedback?.trim()) return c.json({ error: 'feedback is required.' }, 400);
        const item = deps.appStudioStore.getWorkItem(id, workItemId);
        if (!item) return notFound(c, 'Work item not found');
        if (item.status === 'cancelled') return c.json({ error: 'A cancelled card cannot receive changes.' }, 409);
        const currentItems = getAppWorkflowView(deps, id)?.work_items ?? [];
        const affected = dependentWorkItemIds(currentItems, [item.id]);
        deps.appStudioStore.markWorkItemsStale(id, [...affected], body.feedback.trim());
        const correctionId = `change:${item.id}:${item.revision + 1}`;
        const correctiveKind = item.kind === 'implement' || item.kind === 'contract' ? item.kind : item.kind === 'verify' || item.kind === 'release' ? item.kind : 'change';
        const corrections: UpsertAppStudioWorkItemInput[] = [{
          id: correctionId, app_session_id: id, phase: item.phase, slice_id: item.slice_id,
          title: `Revisar: ${item.title}`, outcome: body.feedback.trim(), kind: correctiveKind, owner_profile: correctiveKind === 'verify' || correctiveKind === 'release' ? 'verify' : item.owner_profile,
          priority: 1, revision: item.revision + 1, status: 'ready' as const, sort_order: item.sort_order,
          depends_on_json: item.depends_on_json, source_ids_json: item.source_ids_json,
          acceptance_json: JSON.stringify([...new Set([...(JSON.parse(item.acceptance_json) as string[]), body.feedback.trim()])]),
          file_scope_json: item.file_scope_json, run_json: JSON.stringify({ corrects_work_item_id: item.id }),
        }];
        if (correctiveKind === 'implement' || correctiveKind === 'contract') corrections.push({
          id: `${correctionId}:verify`, app_session_id: id, phase: item.phase, slice_id: item.slice_id,
          title: `Verificar: ${item.title}`, outcome: `Validar a correção solicitada: ${body.feedback.trim()}`, kind: 'verify', owner_profile: item.owner_profile === 'verify' ? 'independent-verify' : 'verify',
          priority: 1, revision: item.revision + 1, status: 'backlog', sort_order: item.sort_order + 1,
          depends_on_json: JSON.stringify([correctionId]), source_ids_json: item.source_ids_json,
          acceptance_json: JSON.stringify([...new Set([...(JSON.parse(item.acceptance_json) as string[]), body.feedback.trim()])]),
          file_scope_json: '[]', run_json: null,
        });
        deps.appStudioStore.upsertWorkItems(corrections);
        deps.appStudioStore.refreshReadyWorkItems(id);
      } else return c.json({ error: 'Unknown work item action.' }, 400);
      const workflow = getAppWorkflowView(deps, id)!;
      if (body.action === 'pause' || body.action === 'cancel') {
        wakeCoordinator(app, workflow.coordinator_session_id, `[App Studio] O card '${workItemId}' foi ${body.action === 'pause' ? 'pausado' : 'cancelado'} pelo usuário. Interrompa/cancele a tarefa correspondente no execute_tasks e preserve as evidências já registradas.`);
      } else if (body.action === 'request_changes') {
        wakeCoordinator(app, workflow.coordinator_session_id, `[App Studio] O usuário solicitou mudanças no card '${workItemId}': ${body.feedback!.trim()}. Releia o Kanban e execute somente a revisão corretiva.`);
      }
      return c.json({ workflow });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 409);
    }
  });

  app.post('/api/app-studio/sessions/:id/decisions/:decisionId/resolve', async (c) => {
    const id = parseIdParam(c);
    if (!deps.appStudioStore.getSession(id)) return notFound(c);
    const decisionId = Number(c.req.param('decisionId'));
    const body = await c.req.json<{ answer?: string }>();
    if (!body.answer?.trim()) return c.json({ error: 'answer is required.' }, 400);
    try {
      const decision = deps.appStudioStore.resolveDecisionRequest(id, decisionId, body.answer.trim());
      deps.appStudioStore.refreshReadyWorkItems(id);
      const workflow = getAppWorkflowView(deps, id)!;
      wakeCoordinator(app, workflow.coordinator_session_id, `[App Studio] Decisão respondida: ${decision.question}\nResposta: ${body.answer.trim()}\nContinue pelos cards liberados.`);
      return c.json({ decision, workflow });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 409);
    }
  });

  app.get('/api/app-studio/sessions/:id/events', (c) => {
    const id = parseIdParam(c);
    if (!deps.appStudioStore.getSession(id)) return notFound(c);
    let cursor = Number(c.req.query('after') ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      while (!stream.closed && !c.req.raw.signal.aborted) {
        const events = deps.appStudioStore.listWorkflowEvents(id, cursor);
        for (const event of events) {
          cursor = event.id;
          await stream.writeSSE({ id: String(event.id), event: event.kind, data: event.payload_json });
        }
        if (events.length === 0) await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ cursor }) });
        await stream.sleep(1_500);
      }
    });
  });
}
