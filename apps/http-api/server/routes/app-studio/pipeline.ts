/**
 * Routes — máquina de etapas do App Studio (pipeline_json, mig 200).
 *
 *   PATCH /api/app-studio/sessions/:id/pipeline/stage
 *         { stage_id, action: 'start'|'approve'|'reopen'|'skip', feedback? }
 *         — transições do USUÁRIO (o agente só submete, via app_submit_stage).
 *   POST  /api/app-studio/sessions/:id/pipeline/init
 *         — resgate para sessões cuja criação falhou ao semear o pipeline.
 */
import type { Hono } from 'hono';
import {
  APP_STAGE_IDS,
  AppStageTransitionError,
  applyStageAction,
  applyStageSubmit,
  createPipelineState,
  parsePipelineState,
  serializePipelineState,
  type AppStageAction,
  type AppStageId,
} from '@mcp/app-studio/pipeline/stages.js';
import { runAppStageGate } from '@mcp/app-studio/pipeline/gates.js';
import { buildFeatureRoadmap } from '@mcp/app-studio/pipeline/roadmap.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { parseAppUxBrief, parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { parseAppProductModel } from '@mcp/app-studio/product/types.js';
import type { AppStudioFeatureKind } from '@mcp/store/app-studio-store.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

const ACTIONS: ReadonlySet<string> = new Set(['start', 'approve', 'reopen', 'skip']);
const RESET_FEATURES_ON_REOPEN: Record<AppStageId, AppStudioFeatureKind[]> = {
  discovery: ['screen', 'api', 'feature'],
  product: ['screen', 'api', 'feature'],
  architecture: ['screen', 'api', 'feature'],
  database: ['screen', 'api', 'feature'],
  ux: ['screen', 'api', 'feature'],
  wireframe: ['screen', 'api', 'feature'],
  design: ['screen', 'api', 'feature'],
  backend: ['api', 'feature'],
  review: [],
  launch: [],
};

export function mountAppStudioPipelineRoutes(app: Hono, deps: ServerDeps): void {
  const { appStudioStore } = deps;

  app.patch('/api/app-studio/sessions/:id/pipeline/stage', async (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const body = await parseJsonBody<{ stage_id?: string; action?: string; feedback?: string }>(c);
    const stageId = body.stage_id as AppStageId | undefined;
    const action = body.action as AppStageAction | undefined;
    if (!stageId || !APP_STAGE_IDS.includes(stageId)) {
      return c.json({ error: `Body must include stage_id ∈ {${APP_STAGE_IDS.join(', ')}}.` }, 400);
    }
    if (!action || !ACTIONS.has(action)) {
      return c.json({ error: 'Body must include action ∈ {start, approve, reopen, skip}.' }, 400);
    }
    const state = parsePipelineState(session.pipeline_json);
    if (!state) {
      return c.json({ error: 'No pipeline initialized — POST …/pipeline/init first.' }, 409);
    }
    try {
      if (action === 'approve' && stageId === 'architecture') {
        const revision = appStudioStore.getLatestArchitectureRevision(id);
        if (!revision || (revision.status !== 'draft' && revision.status !== 'approved')) {
          return c.json({ error: 'No architecture revision is ready for approval.' }, 409);
        }
      }
      if (action === 'approve' && stageId === 'product') {
        const revision = appStudioStore.getLatestProductRevision(id);
        const model = parseAppProductModel(revision?.product_json);
        if (!revision || revision.status !== 'draft' || !model) return c.json({ error: 'No product revision is ready for approval.' }, 409);
      }
      if (action === 'approve' && stageId === 'ux') {
        const revision = appStudioStore.getLatestUxRevision(id);
        if (!revision || revision.status !== 'draft') return c.json({ error: 'No UX revision is ready for approval.' }, 409);
      }
      if (action === 'approve' && stageId === 'wireframe') {
        const revision = appStudioStore.getLatestWireframeRevision(id);
        if (!revision || revision.status !== 'draft') return c.json({ error: 'No wireframe revision is ready for approval.' }, 409);
      }
      const next = applyStageAction(state, stageId, action, body.feedback ?? null);
      let updated;
      if (action === 'approve' && stageId === 'product') {
        const revision = appStudioStore.getLatestProductRevision(id)!;
        const model = parseAppProductModel(revision.product_json)!;
        updated = appStudioStore.approveProductRevision({
          sessionId: id,
          revisionId: revision.id,
          candidateSpecJson: JSON.stringify(model.candidate_spec, null, 2),
          afterPipelineJson: serializePipelineState(next),
        }).session;
      } else {
        updated = appStudioStore.setPipelineJson(id, serializePipelineState(next));
      }
      if (action === 'approve' && stageId === 'discovery') {
        appStudioStore.ensureInitialSpecRevision(id, {
          title: 'Versão inicial',
          summary: 'Primeiro plano aprovado do app.',
          created_by: 'user',
        });
      }
      if (action === 'approve' && stageId === 'architecture') {
        const revision = appStudioStore.getLatestArchitectureRevision(id)!;
        if (revision.status === 'draft') appStudioStore.approveArchitectureRevision(id, revision.id);
      }
      if (action === 'approve' && stageId === 'ux') {
        const revision = appStudioStore.getLatestUxRevision(id)!;
        appStudioStore.approveUxRevision(id, revision.id);
      }
      if (action === 'approve' && stageId === 'wireframe') {
        const revision = appStudioStore.getLatestWireframeRevision(id)!;
        const plan = parseAppWireframePlan(revision.wireframe_json)!;
        appStudioStore.approveWireframeRevision(id, revision.id, plan.build_groups.map((group) => group.id), plan.tasks.map((task) => task.id));
      }
      if (action === 'reopen') {
        appStudioStore.deleteFeaturesByKinds(id, RESET_FEATURES_ON_REOPEN[stageId]);
      }
      return c.json({ session: updated, pipeline: next });
    } catch (e) {
      if (e instanceof AppStageTransitionError) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  app.post('/api/app-studio/sessions/:id/pipeline/stage/recheck', async (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const body = await parseJsonBody<{ stage_id?: string }>(c);
    const stageId = body.stage_id as AppStageId | undefined;
    if (!stageId || !APP_STAGE_IDS.includes(stageId)) {
      return c.json({ error: `Body must include stage_id ∈ {${APP_STAGE_IDS.join(', ')}}.` }, 400);
    }
    const state = parsePipelineState(session.pipeline_json);
    const stage = state?.stages.find((item) => item.id === stageId);
    if (!state || !stage || stage.status !== 'active' || !stage.submitted_at) {
      return c.json({ error: 'Only a previously submitted active stage can be checked again.' }, 409);
    }
    const project = deps.db.getProject(session.project_id);
    if (!project?.root_path) return c.json({ error: 'The app workspace was not found.' }, 409);
    const architectureRevision = appStudioStore.getLatestArchitectureRevision(id);
    const productRevision = appStudioStore.getLatestProductRevision(id);
    const currentSpecRevision = appStudioStore.getLatestApprovedSpecRevision(id);
    const uxRevision = appStudioStore.getLatestUxRevision(id);
    const wireframeRevision = appStudioStore.getLatestWireframeRevision(id);
    const gate = await runAppStageGate({
      stage: stageId,
      workspaceDir: project.root_path,
      state,
      spec: parseAppSpec(session.spec_json),
      recorded: appStudioStore.listFeatures(id).map((feature) => ({ name: feature.name, kind: feature.kind })),
      architecture: parseAppArchitecturePlan(architectureRevision?.architecture_json),
      product: parseAppProductModel(productRevision?.product_json),
      productStatus: productRevision?.status ?? null,
      currentSpecRevisionId: currentSpecRevision?.id ?? null,
      currentArchitectureRevisionId: architectureRevision?.id ?? null,
      currentUxRevisionId: uxRevision?.id ?? null,
      ux: parseAppUxBrief(uxRevision?.ux_json),
      uxStatus: uxRevision?.status ?? null,
      wireframe: parseAppWireframePlan(wireframeRevision?.wireframe_json),
      wireframeStatus: wireframeRevision?.status ?? null,
      buildGroups: wireframeRevision ? appStudioStore.listBuildGroups(wireframeRevision.id) : [],
      buildTasks: wireframeRevision ? appStudioStore.listBuildTaskEvidence(wireframeRevision.id) : [],
    });
    const next = applyStageSubmit(state, stageId, stage.summary ?? 'Etapa verificada novamente.', gate);
    const updated = appStudioStore.setPipelineJson(id, serializePipelineState(next));
    return c.json({ session: updated, pipeline: next, gate, ready_for_review: gate.ok });
  });

  app.post('/api/app-studio/sessions/:id/pipeline/init', (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    if (parsePipelineState(session.pipeline_json)) {
      return c.json({ error: 'Pipeline already initialized.' }, 409);
    }
    const state = createPipelineState();
    // Sessão que já tem spec (init tardio): reconstrói o roadmap dela.
    const spec = parseAppSpec(session.spec_json);
    if (spec) state.roadmap = buildFeatureRoadmap(spec);
    const updated = appStudioStore.setPipelineJson(id, serializePipelineState(state));
    return c.json({ session: updated, pipeline: state });
  });
}
