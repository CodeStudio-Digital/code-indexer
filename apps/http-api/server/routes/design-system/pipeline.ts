/**
 * Routes — máquina de etapas do DS Studio (pipeline_json, mig 190).
 *
 *   PATCH /api/design-system/sessions/:id/pipeline/stage
 *         { stage_id, action: 'start'|'approve'|'reopen'|'skip', feedback? }
 *         — transições do USUÁRIO (o agente só submete, via ds_submit_stage).
 *   POST  /api/design-system/sessions/:id/pipeline/init
 *         — backfill para sessões studio pré-pipeline (ex.: "Corporate"):
 *           monta roadmap do digest (se existir) e semeia as 7 etapas.
 *   POST  /api/design-system/sessions/:id/analyze-import
 *         — regenera o theme digest sobre <workspace>/import/.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';
import {
  DS_STAGE_IDS,
  DsStageTransitionError,
  applyStageAction,
  createPipelineState,
  parsePipelineState,
  serializePipelineState,
  type DsStageAction,
  type DsStageId,
} from '@mcp/design-system/pipeline/stages.js';
import { buildRoadmap } from '@mcp/design-system/pipeline/roadmap.js';
import {
  THEME_ANALYSIS_DIRNAME,
  THEME_DIGEST_FILENAME,
  writeThemeDigest,
  type ThemeDigest,
  type ThemeDigestSummary,
} from '@mcp/design-system/theme-digest/theme-digest.js';

const ACTIONS: ReadonlySet<string> = new Set(['start', 'approve', 'reopen', 'skip']);

function readDigestWithSummary(
  workspaceDir: string,
): { digest: ThemeDigest; summary: ThemeDigestSummary } | null {
  const path = join(workspaceDir, 'import', THEME_ANALYSIS_DIRNAME, THEME_DIGEST_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const digest = JSON.parse(raw) as ThemeDigest;
    return {
      digest,
      summary: {
        sha256: createHash('sha256').update(raw).digest('hex'),
        generated_at: digest.generated_at,
        files: digest.totals.files,
        colors: digest.tokens.colors.length,
        components: digest.components.length,
      },
    };
  } catch {
    return null;
  }
}

export function mountDesignSystemPipelineRoutes(app: Hono, deps: ServerDeps): void {
  const { designSystemStore, db } = deps;

  /** Sessão studio + root do projeto-workspace, ou uma resposta de erro. */
  function resolveStudio(id: number) {
    const session = designSystemStore.getSession(id);
    if (!session) return { error: 'not-found' as const };
    if (session.kind !== 'studio') return { error: 'legacy' as const };
    const project = session.project_id != null ? db.getProject(session.project_id) : null;
    if (!project?.root_path) return { error: 'no-workspace' as const };
    return { session, workspaceDir: project.root_path };
  }

  app.patch('/api/design-system/sessions/:id/pipeline/stage', async (c) => {
    const id = parseIdParam(c);
    const resolved = resolveStudio(id);
    if ('error' in resolved) {
      if (resolved.error === 'not-found') return notFound(c);
      return c.json({ error: 'Pipeline is only available for studio sessions with a workspace.' }, 400);
    }
    const body = await parseJsonBody<{ stage_id?: string; action?: string; feedback?: string }>(c);
    const stageId = body.stage_id as DsStageId | undefined;
    const action = body.action as DsStageAction | undefined;
    if (!stageId || !DS_STAGE_IDS.includes(stageId)) {
      return c.json({ error: `Body must include stage_id ∈ {${DS_STAGE_IDS.join(', ')}}.` }, 400);
    }
    if (!action || !ACTIONS.has(action)) {
      return c.json({ error: 'Body must include action ∈ {start, approve, reopen, skip}.' }, 400);
    }
    const state = parsePipelineState(resolved.session.pipeline_json);
    if (!state) {
      return c.json({ error: 'No pipeline initialized — POST …/pipeline/init first.' }, 409);
    }
    try {
      const next = applyStageAction(state, stageId, action, body.feedback ?? null);
      const session = designSystemStore.setPipelineJson(id, serializePipelineState(next));
      return c.json({ session, pipeline: next });
    } catch (e) {
      if (e instanceof DsStageTransitionError) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  app.post('/api/design-system/sessions/:id/pipeline/init', async (c) => {
    const id = parseIdParam(c);
    const resolved = resolveStudio(id);
    if ('error' in resolved) {
      if (resolved.error === 'not-found') return notFound(c);
      return c.json({ error: 'Pipeline is only available for studio sessions with a workspace.' }, 400);
    }
    if (parsePipelineState(resolved.session.pipeline_json)) {
      return c.json({ error: 'Pipeline already initialized.' }, 409);
    }
    const found = readDigestWithSummary(resolved.workspaceDir);
    const roadmap = buildRoadmap({
      mode: resolved.session.mode,
      digestComponents: found?.digest.components ?? null,
      digestPages: found?.digest.pages ?? null,
    });
    const state = createPipelineState(roadmap, found?.summary ?? null);
    const session = designSystemStore.setPipelineJson(id, serializePipelineState(state));
    return c.json({ session, pipeline: state });
  });

  app.post('/api/design-system/sessions/:id/analyze-import', async (c) => {
    const id = parseIdParam(c);
    const resolved = resolveStudio(id);
    if ('error' in resolved) {
      if (resolved.error === 'not-found') return notFound(c);
      return c.json({ error: 'Theme analysis is only available for studio sessions with a workspace.' }, 400);
    }
    const importDir = join(resolved.workspaceDir, 'import');
    if (!existsSync(importDir)) {
      return c.json({ error: 'No import/ directory — attach reference material first (re-extract).' }, 400);
    }
    try {
      const summary = await writeThemeDigest(importDir);
      const state = parsePipelineState(resolved.session.pipeline_json);
      if (state) {
        state.theme_digest = summary;
        designSystemStore.setPipelineJson(id, serializePipelineState(state));
      }
      return c.json({ ok: true, digest: summary });
    } catch (e) {
      return c.json({ error: `Theme analysis failed: ${(e as Error).message}` }, 500);
    }
  });
}
