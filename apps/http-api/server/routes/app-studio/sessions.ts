/**
 * Routes — App Studio sessions.
 *
 *   GET    /api/app-studio/sessions      → list (enriquecidas p/ os cards da Home)
 *   GET    /api/app-studio/sessions/:id  → detail (workflow + artifacts + deploy + features)
 *   DELETE /api/app-studio/sessions/:id  → remove a face App Studio (o projeto fica)
 *
 * Criação é exclusiva de `POST /api/app-studio` (scaffold SSE). O
 * O progresso é derivado do workflow v5 e dos cards persistidos.
 */
import type { Hono } from 'hono';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import type { AppStudioSession } from '@mcp/store/app-studio-store.js';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { auditAppUxBrief, auditAppWireframePlan } from '@mcp/app-studio/experience/audit.js';
import { parseAppUxBrief, parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { auditAppProductModel } from '@mcp/app-studio/product/audit.js';
import { parseAppProductModel, productModelFingerprint } from '@mcp/app-studio/product/types.js';
import { parseIdParam, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';
import { getAppWorkflowView } from './workflow-service.js';

function parseJsonColumn<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function mountAppStudioSessionRoutes(app: Hono, deps: ServerDeps): void {
  const { appStudioStore, db } = deps;

  function enrich(session: AppStudioSession) {
    const project = db.getProject(session.project_id);
    const builder = parseJsonColumn<{ port?: number }>(project?.builder_json ?? null);
    const workflow = getAppWorkflowView(deps, session.id);
    const current = workflow?.state.phases.find((phase) => phase.status === 'active' || phase.status === 'attention') ?? null;
    const deploy = parseJsonColumn<{ url?: string | null }>(session.deploy_json);
    return {
      ...session,
      project: project
        ? { id: project.id, name: project.name, root_path: project.root_path }
        : null,
      builder_port: typeof builder?.port === 'number' ? builder.port : null,
      current_phase: current?.id ?? null,
      current_phase_status: current?.status ?? null,
      phase_total: workflow?.state.phases.length ?? 0,
      phase_done: workflow?.state.phases.filter((phase) => phase.status === 'complete').length ?? 0,
      live_url: deploy?.url ?? null,
    };
  }

  app.get('/api/app-studio/sessions', (c) => {
    return c.json({ sessions: appStudioStore.listSessions().map(enrich) });
  });

  app.get('/api/app-studio/sessions/:id', (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const enriched = enrich(session);
    const architectureRevision = appStudioStore.getLatestArchitectureRevision(id);
    const architecture = parseAppArchitecturePlan(architectureRevision?.architecture_json);
    const spec = parseAppSpec(session.spec_json);
    const productRevision = appStudioStore.getLatestProductRevision(id);
    const product = parseAppProductModel(productRevision?.product_json);
    const uxRevision = appStudioStore.getLatestUxRevision(id);
    const ux = parseAppUxBrief(uxRevision?.ux_json);
    const wireframeRevision = appStudioStore.getLatestWireframeRevision(id);
    const wireframe = parseAppWireframePlan(wireframeRevision?.wireframe_json);
    return c.json({
      session,
      project: enriched.project,
      builder_port: enriched.builder_port,
      workflow: getAppWorkflowView(deps, id),
      spec,
      product: productRevision && product ? {
        id: productRevision.id,
        revision_number: productRevision.revision_number,
        base_spec_revision_id: productRevision.base_spec_revision_id,
        result_spec_revision_id: productRevision.result_spec_revision_id,
        status: productRevision.status,
        created_at: productRevision.created_at,
        updated_at: productRevision.updated_at,
        approved_at: productRevision.approved_at,
        fingerprint: productModelFingerprint(product),
        model: product,
        audit: auditAppProductModel(product),
      } : null,
      architecture: architectureRevision && architecture ? {
        id: architectureRevision.id,
        revision_number: architectureRevision.revision_number,
        spec_revision_id: architectureRevision.spec_revision_id,
        status: architectureRevision.status,
        created_at: architectureRevision.created_at,
        updated_at: architectureRevision.updated_at,
        approved_at: architectureRevision.approved_at,
        plan: architecture,
        audit: auditAppArchitecture(architecture, spec, product),
      } : null,
      ux: uxRevision && ux ? {
        id: uxRevision.id,
        revision_number: uxRevision.revision_number,
        spec_revision_id: uxRevision.spec_revision_id,
        architecture_revision_id: uxRevision.architecture_revision_id,
        data_fingerprint: uxRevision.data_fingerprint,
        status: uxRevision.status,
        created_at: uxRevision.created_at,
        updated_at: uxRevision.updated_at,
        approved_at: uxRevision.approved_at,
        brief: ux,
        audit: auditAppUxBrief(ux),
      } : null,
      wireframe: wireframeRevision && wireframe ? {
        id: wireframeRevision.id,
        revision_number: wireframeRevision.revision_number,
        spec_revision_id: wireframeRevision.spec_revision_id,
        architecture_revision_id: wireframeRevision.architecture_revision_id,
        ux_revision_id: wireframeRevision.ux_revision_id,
        data_fingerprint: wireframeRevision.data_fingerprint,
        status: wireframeRevision.status,
        created_at: wireframeRevision.created_at,
        updated_at: wireframeRevision.updated_at,
        approved_at: wireframeRevision.approved_at,
        plan: wireframe,
        audit: auditAppWireframePlan(wireframe, spec, architecture, product),
      } : null,
      deploy: parseJsonColumn(session.deploy_json),
    });
  });

  app.delete('/api/app-studio/sessions/:id', (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    // Remove só a face App Studio (sessão + features). O projeto-workspace
    // e os arquivos no disco ficam — é um projeto real do usuário. Mas o
    // `builder_json kind:'app'` PRECISA ser neutralizado: sem a sessão, o
    // runner ainda registraria as tools app_* + o prompt do studio e toda
    // chamada erraria com "No AppStudioSession bound" (chat builder
    // permanentemente quebrado). Zerar volta o projeto a um projeto normal.
    appStudioStore.deleteSession(id);
    try {
      db.updateProject(session.project_id, { builder_json: null });
    } catch {
      /* projeto já removido — nada a limpar */
    }
    return c.json({ ok: true });
  });
}
