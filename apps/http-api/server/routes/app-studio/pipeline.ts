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
  createPipelineState,
  parsePipelineState,
  serializePipelineState,
  type AppStageAction,
  type AppStageId,
} from '@mcp/app-studio/pipeline/stages.js';
import { buildFeatureRoadmap } from '@mcp/app-studio/pipeline/roadmap.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import type { AppStudioFeatureKind } from '@mcp/store/app-studio-store.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

const ACTIONS: ReadonlySet<string> = new Set(['start', 'approve', 'reopen', 'skip']);
const RESET_FEATURES_ON_REOPEN: Record<AppStageId, AppStudioFeatureKind[]> = {
  discovery: ['screen', 'api', 'feature'],
  architecture: ['screen', 'api', 'feature'],
  database: ['screen', 'api', 'feature'],
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
      const next = applyStageAction(state, stageId, action, body.feedback ?? null);
      const updated = appStudioStore.setPipelineJson(id, serializePipelineState(next));
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
      if (action === 'reopen') {
        appStudioStore.deleteFeaturesByKinds(id, RESET_FEATURES_ON_REOPEN[stageId]);
      }
      return c.json({ session: updated, pipeline: next });
    } catch (e) {
      if (e instanceof AppStageTransitionError) return c.json({ error: e.message }, 409);
      throw e;
    }
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
