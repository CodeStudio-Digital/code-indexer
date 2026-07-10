/**
 * Routes — App Studio spec revisions and product evolutions.
 *
 * These endpoints keep `app_studio_sessions.spec_json` as the current cache,
 * but give the guided builder a real timeline: approved revisions, draft
 * changes and impact-aware application back into the stage pipeline.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Hono } from 'hono';
import {
  applyEvolutionImpact,
  createPipelineState,
  parsePipelineState,
  replaceRoadmap,
  serializePipelineState,
  type AppPipelineState,
  type AppStageId,
} from '@mcp/app-studio/pipeline/stages.js';
import { buildFeatureRoadmap } from '@mcp/app-studio/pipeline/roadmap.js';
import { prepareSpecSave } from '@mcp/app-studio/spec/save-core.js';
import { parseAppSpec, serializeAppSpec, type AppSpec } from '@mcp/app-studio/spec/types.js';
import {
  diffAppSpecs,
  impactFromSpecDiff,
  summarizeSpecDiff,
  type AppSpecDiff,
  type AppSpecImpact,
} from '@mcp/app-studio/spec/revisions.js';
import type {
  AppStudioFeatureKind,
  AppStudioSpecRevision,
  AppStudioEvolution,
} from '@mcp/store/app-studio-store.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

const RESET_FEATURES_FROM_STAGE: Record<AppStageId, AppStudioFeatureKind[]> = {
  discovery: ['screen', 'api', 'feature'],
  architecture: ['screen', 'api', 'feature'],
  database: ['screen', 'api', 'feature'],
  design: ['screen', 'api', 'feature'],
  backend: ['api', 'feature'],
  review: [],
  launch: [],
};

export function mountAppStudioRevisionRoutes(app: Hono, deps: ServerDeps): void {
  const { appStudioStore, db } = deps;

  app.get('/api/app-studio/sessions/:id/revisions', (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const current = appStudioStore.ensureInitialSpecRevision(id);
    return c.json({
      current_revision_id: current?.id ?? null,
      revisions: appStudioStore.listSpecRevisions(id).map(revisionView),
      evolutions: appStudioStore.listEvolutions(id).map(evolutionView),
    });
  });

  app.post('/api/app-studio/sessions/:id/evolutions', async (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const body = await parseJsonBody<{ title?: string; description?: string }>(c);
    const title = body.title?.trim();
    if (!title) return c.json({ error: 'Body must include a title.' }, 400);
    const base = appStudioStore.ensureInitialSpecRevision(id);
    const evolution = appStudioStore.createEvolution({
      app_session_id: id,
      base_revision_id: base?.id ?? null,
      title,
      description: body.description?.trim() || null,
    });
    return c.json({ evolution: evolutionView(evolution), base_revision: base ? revisionView(base) : null });
  });

  app.post('/api/app-studio/sessions/:id/evolutions/:evolutionId/propose', async (c) => {
    const id = parseIdParam(c);
    const evolutionId = parseIdParam(c, 'evolutionId');
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const evolution = appStudioStore.getEvolution(evolutionId);
    if (!evolution || evolution.app_session_id !== id) return notFound(c, 'Evolution not found');

    const body = await parseJsonBody<{ spec?: unknown; title?: string; summary?: string; change_reason?: string }>(c);
    const prepared = prepareSpecSave(body.spec, session.pipeline_json);
    if (!prepared.ok) return c.json({ issues: prepared.issues }, 400);

    const baseRevision = resolveBaseRevision(appStudioStore, id, evolution.base_revision_id);
    const baseSpec = parseAppSpec(baseRevision?.spec_json);
    const diff = diffAppSpecs(baseSpec, prepared.spec);
    const impact = impactFromSpecDiff(diff);
    const revision = appStudioStore.createSpecRevision({
      app_session_id: id,
      status: 'draft',
      title: body.title?.trim() || evolution.title,
      summary: body.summary?.trim() || summarizeSpecDiff(diff).join('\n'),
      change_reason: body.change_reason?.trim() || evolution.description,
      spec_json: prepared.specJson,
      base_revision_id: baseRevision?.id ?? null,
      diff_json: JSON.stringify(diff),
      impact_json: JSON.stringify(impact),
      created_by: 'agent',
    });
    const now = new Date().toISOString();
    const updatedEvolution = appStudioStore.updateEvolution(evolution.id, {
      status: 'review',
      proposed_revision_id: revision.id,
      impact_json: JSON.stringify(impact),
      submitted_at: evolution.submitted_at ?? now,
    });
    return c.json({
      revision: revisionView(revision),
      evolution: evolutionView(updatedEvolution),
      diff,
      impact,
      summary: summarizeSpecDiff(diff),
    });
  });

  app.post('/api/app-studio/sessions/:id/evolutions/:evolutionId/apply', async (c) => {
    const id = parseIdParam(c);
    const evolutionId = parseIdParam(c, 'evolutionId');
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const evolution = appStudioStore.getEvolution(evolutionId);
    if (!evolution || evolution.app_session_id !== id) return notFound(c, 'Evolution not found');
    if (!evolution.proposed_revision_id) return c.json({ error: 'Evolution has no proposed revision.' }, 409);
    const revision = appStudioStore.getSpecRevision(evolution.proposed_revision_id);
    if (!revision || revision.app_session_id !== id) return c.json({ error: 'Proposed revision not found.' }, 409);
    const spec = parseAppSpec(revision.spec_json);
    if (!spec) return c.json({ error: 'Proposed revision contains an invalid spec.' }, 409);

    const impact = revisionImpact(revision);
    appStudioStore.approveSpecRevision(id, revision.id);
    const pipeline = pipelineForSpec(session.pipeline_json, spec);
    applyEvolutionImpact(pipeline, impact.stage_ids, evolution.title);
    appStudioStore.setPipelineJson(id, serializePipelineState(pipeline));
    deleteRecordedFeaturesFromImpact(appStudioStore, id, impact.stage_ids);
    writeSpecMirrorBestEffort(db, session.project_id, spec);

    const now = new Date().toISOString();
    const updatedEvolution = appStudioStore.updateEvolution(evolution.id, {
      status: 'applied',
      approved_at: evolution.approved_at ?? now,
      applied_at: now,
    });
    return c.json({
      session: appStudioStore.getSession(id),
      pipeline,
      revision: revisionView(appStudioStore.getSpecRevision(revision.id)!),
      evolution: evolutionView(updatedEvolution),
      impact,
    });
  });

  app.post('/api/app-studio/sessions/:id/evolutions/:evolutionId/reject', (c) => {
    const id = parseIdParam(c);
    const evolutionId = parseIdParam(c, 'evolutionId');
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const evolution = appStudioStore.getEvolution(evolutionId);
    if (!evolution || evolution.app_session_id !== id) return notFound(c, 'Evolution not found');
    if (evolution.proposed_revision_id) {
      const revision = appStudioStore.getSpecRevision(evolution.proposed_revision_id);
      if (revision?.status === 'draft') {
        // Keep the row as auditable history, but mark it rejected.
        appStudioStore.updateSpecRevisionStatus(revision.id, 'rejected');
      }
    }
    const updated = appStudioStore.updateEvolution(evolution.id, { status: 'rejected' });
    return c.json({ evolution: evolutionView(updated) });
  });

  // Discard an EMPTY draft evolution (a container that never got a proposed
  // revision — e.g. junk left by a looping model). A proposed/approved/applied
  // evolution is real history: reject it, never delete it.
  app.delete('/api/app-studio/sessions/:id/evolutions/:evolutionId', (c) => {
    const id = parseIdParam(c);
    const evolutionId = parseIdParam(c, 'evolutionId');
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const evolution = appStudioStore.getEvolution(evolutionId);
    if (!evolution || evolution.app_session_id !== id) return notFound(c, 'Evolution not found');
    if (evolution.status !== 'draft' || evolution.proposed_revision_id) {
      return c.json({ error: 'Only empty draft evolutions can be discarded.' }, 409);
    }
    appStudioStore.deleteEvolution(evolution.id);
    return c.json({ ok: true, deleted_id: evolution.id });
  });
}

function revisionView(revision: AppStudioSpecRevision) {
  const spec = parseAppSpec(revision.spec_json);
  return {
    ...revision,
    spec_json: undefined,
    diff: parseJson<AppSpecDiff>(revision.diff_json),
    impact: parseJson<AppSpecImpact>(revision.impact_json),
    spec_summary: spec ? specSummary(spec) : null,
  };
}

function evolutionView(evolution: AppStudioEvolution) {
  return {
    ...evolution,
    impact: parseJson<AppSpecImpact>(evolution.impact_json),
  };
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function specSummary(spec: AppSpec) {
  return {
    summary: spec.summary,
    screens: spec.screens.length,
    entities: spec.database.entities.length,
    features: spec.features.length,
    behaviors: spec.behaviors?.length ?? 0,
  };
}

function resolveBaseRevision(
  store: Pick<ServerDeps['appStudioStore'], 'getSpecRevision' | 'ensureInitialSpecRevision'>,
  sessionId: number,
  baseRevisionId: number | null,
): AppStudioSpecRevision | null {
  if (baseRevisionId) return store.getSpecRevision(baseRevisionId);
  return store.ensureInitialSpecRevision(sessionId);
}

function revisionImpact(revision: AppStudioSpecRevision): AppSpecImpact {
  return parseJson<AppSpecImpact>(revision.impact_json) ?? { level: 'none', stage_ids: [], reasons: [] };
}

function pipelineForSpec(pipelineJson: string | null, spec: AppSpec): AppPipelineState {
  const state = parsePipelineState(pipelineJson) ?? createPipelineState();
  return replaceRoadmap(state, buildFeatureRoadmap(spec));
}

function deleteRecordedFeaturesFromImpact(
  store: Pick<ServerDeps['appStudioStore'], 'deleteFeaturesByKinds'>,
  sessionId: number,
  stageIds: AppStageId[],
): void {
  if (stageIds.length === 0) return;
  const first = stageIds
    .slice()
    .sort((a, b) => APP_STAGE_ORDER[a] - APP_STAGE_ORDER[b])[0]!;
  store.deleteFeaturesByKinds(sessionId, RESET_FEATURES_FROM_STAGE[first]);
}

const APP_STAGE_ORDER: Record<AppStageId, number> = {
  discovery: 0,
  architecture: 1,
  database: 2,
  design: 3,
  backend: 4,
  review: 5,
  launch: 6,
};

function writeSpecMirrorBestEffort(db: ServerDeps['db'], projectId: number, spec: AppSpec): void {
  try {
    const project = db.getProject(projectId);
    if (!project?.root_path) return;
    const mirror = join(project.root_path, 'spec', 'app-spec.json');
    mkdirSync(dirname(mirror), { recursive: true });
    writeFileSync(mirror, serializeAppSpec(spec), 'utf8');
  } catch {
    /* espelho é conveniência; a spec canônica já persistiu */
  }
}
