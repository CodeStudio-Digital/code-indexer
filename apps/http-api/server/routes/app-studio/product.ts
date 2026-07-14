import type { Hono } from 'hono';
import { auditAppProductModel } from '@mcp/app-studio/product/audit.js';
import { normalizeAppProductModel, parseAppProductModel, productModelFingerprint, serializeAppProductModel } from '@mcp/app-studio/product/types.js';
import { parseAppWorkflowState } from '@mcp/app-studio/workflow/state.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

export function mountAppStudioProductRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/app-studio/sessions/:id/product', (c) => {
    const id = parseIdParam(c);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const revision = deps.appStudioStore.getLatestProductRevision(id);
    const model = parseAppProductModel(revision?.product_json);
    return c.json({ revision, model, audit: auditAppProductModel(model) });
  });

  app.patch('/api/app-studio/sessions/:id/product', async (c) => {
    const id = parseIdParam(c);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const state = parseAppWorkflowState(session.pipeline_json);
    const define = state?.phases.find((phase) => phase.id === 'define');
    if (!state || define?.status === 'locked' || define?.status === 'complete') return c.json({ error: 'A modelagem do produto não está aberta para edição.' }, 409);
    const revision = deps.appStudioStore.getLatestProductRevision(id);
    const model = parseAppProductModel(revision?.product_json);
    if (!revision || revision.status !== 'draft' || !model) return c.json({ error: 'Nenhum rascunho de produto está disponível.' }, 409);
    const body = await parseJsonBody<{
      expected_revision_number?: number;
      selections?: Array<{ capability_id: string; selected: boolean; horizon?: string }>;
      decisions?: typeof model.decisions;
    }>(c);
    if (body.expected_revision_number !== revision.revision_number) return c.json({ error: 'O produto mudou. Atualize a tela antes de editar.' }, 409);
    const next = structuredClone(model);
    for (const selection of body.selections ?? []) {
      const capability = next.capabilities.find((item) => item.id === selection.capability_id);
      if (!capability) return c.json({ error: `Capacidade desconhecida: ${selection.capability_id}.` }, 400);
      capability.selected = selection.selected;
      if (selection.horizon && ['core', 'complete', 'future', 'declined'].includes(selection.horizon)) capability.horizon = selection.horizon as typeof capability.horizon;
    }
    if (body.decisions) next.decisions = body.decisions;
    const normalized = normalizeAppProductModel(next, model.base_spec_revision_id);
    const saved = deps.appStudioStore.saveProductRevision({
      app_session_id: id,
      base_revision_id: revision.base_revision_id,
      base_spec_revision_id: revision.base_spec_revision_id,
      complexity: normalized.complexity,
      research_fingerprint: productModelFingerprint(normalized),
      product_json: serializeAppProductModel(normalized),
      created_by: 'user',
    }, revision.revision_number);
    return c.json({ revision: saved, model: normalized, audit: auditAppProductModel(normalized) });
  });
}
