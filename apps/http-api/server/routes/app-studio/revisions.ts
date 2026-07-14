/**
 * Routes — App Studio spec revisions and product evolutions.
 *
 * These endpoints keep `app_studio_sessions.spec_json` as the current cache,
 * but give the guided builder a real timeline: approved revisions, draft
 * changes. Approval/application happens only through the Scope gate in v5.
 */
import type { Hono } from 'hono';
import { prepareSpecSave } from '@mcp/app-studio/spec/save-core.js';
import { parseAppSpec, type AppSpec } from '@mcp/app-studio/spec/types.js';
import {
  diffAppSpecs,
  impactFromSpecDiff,
  parseAppSpecImpact,
  summarizeSpecDiff,
  type AppSpecDiff,
} from '@mcp/app-studio/spec/revisions.js';
import type { AppStudioSpecRevision, AppStudioEvolution } from '@mcp/store/app-studio-store.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

export function mountAppStudioRevisionRoutes(app: Hono, deps: ServerDeps): void {
  const { appStudioStore } = deps;

  app.get('/api/app-studio/sessions/:id/revisions', (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const current = appStudioStore.getLatestApprovedSpecRevision(id);
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
    const base = appStudioStore.getLatestApprovedSpecRevision(id);
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
    appStudioStore.requestApproval({
      sessionId: id,
      type: 'scope',
      bundleRevision: revision.revision_number,
      bundleJson: JSON.stringify({ spec_revision_id: revision.id }),
      summary: body.summary?.trim() || summarizeSpecDiff(diff).join('\n') || evolution.title,
    });
    return c.json({
      revision: revisionView(revision),
      evolution: evolutionView(updatedEvolution),
      diff,
      impact,
      summary: summarizeSpecDiff(diff),
    });
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
    impact: parseAppSpecImpact(revision.impact_json),
    spec_summary: spec ? specSummary(spec) : null,
  };
}

function evolutionView(evolution: AppStudioEvolution) {
  return {
    ...evolution,
    impact: parseAppSpecImpact(evolution.impact_json),
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
  store: Pick<ServerDeps['appStudioStore'], 'getSpecRevision' | 'getLatestApprovedSpecRevision'>,
  sessionId: number,
  baseRevisionId: number | null,
): AppStudioSpecRevision | null {
  if (baseRevisionId) return store.getSpecRevision(baseRevisionId);
  return store.getLatestApprovedSpecRevision(sessionId);
}
