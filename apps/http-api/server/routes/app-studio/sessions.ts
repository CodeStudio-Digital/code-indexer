/**
 * Routes — App Studio sessions.
 *
 *   GET    /api/app-studio/sessions      → list (enriquecidas p/ os cards da Home)
 *   GET    /api/app-studio/sessions/:id  → detail (pipeline + spec + interview + deploy + features)
 *   DELETE /api/app-studio/sessions/:id  → remove a face App Studio (o projeto fica)
 *
 * Criação é exclusiva de `POST /api/app-studio` (scaffold SSE). O
 * progresso do roadmap é DERIVADO em leitura (roadmapProgress × features
 * registradas) — nunca armazenado.
 */
import type { Hono } from 'hono';
import { currentStage, parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { roadmapProgress } from '@mcp/app-studio/pipeline/roadmap.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import type { AppStudioSession } from '@mcp/store/app-studio-store.js';
import { parseIdParam, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

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

  function pipelineView(session: AppStudioSession) {
    const state = parsePipelineState(session.pipeline_json);
    if (!state) return null;
    const recorded = appStudioStore
      .listFeatures(session.id)
      .map((f) => ({ name: f.name, kind: f.kind }));
    return {
      stages: state.stages,
      current_stage: currentStage(state)?.id ?? null,
      roadmap: roadmapProgress(state.roadmap, recorded),
    };
  }

  function enrich(session: AppStudioSession) {
    const project = db.getProject(session.project_id);
    const builder = parseJsonColumn<{ port?: number }>(project?.builder_json ?? null);
    const state = parsePipelineState(session.pipeline_json);
    const current = state ? currentStage(state) : null;
    const deploy = parseJsonColumn<{ url?: string | null }>(session.deploy_json);
    return {
      ...session,
      project: project
        ? { id: project.id, name: project.name, root_path: project.root_path }
        : null,
      builder_port: typeof builder?.port === 'number' ? builder.port : null,
      current_stage: current?.id ?? null,
      current_stage_status: current?.status ?? null,
      stage_total: state?.stages.length ?? 0,
      stage_done: state ? state.stages.filter((s) => s.status === 'approved' || s.status === 'skipped').length : 0,
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
    return c.json({
      session,
      project: enriched.project,
      builder_port: enriched.builder_port,
      pipeline: pipelineView(session),
      spec: parseAppSpec(session.spec_json),
      deploy: parseJsonColumn(session.deploy_json),
      features: appStudioStore.listFeatures(id),
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
