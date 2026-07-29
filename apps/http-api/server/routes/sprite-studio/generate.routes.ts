/**
 * Sprite Studio — generation + job control + candidate flow.
 *
 *   POST /projects/:projectId/generate          enqueue a generation job
 *   GET  /projects/:projectId/jobs               recent job ledger
 *   POST /jobs/:id/cancel                        abort a running/queued job
 *   GET  /jobs/:id/candidates/:i/thumb           staged candidate preview
 *   POST /projects/:projectId/assets/:assetId/pick  promote a candidate → version
 *
 * Interactive jobs stage candidates in the scratch dir (no version rows) and
 * finish with `candidates[]`; the user picks one to create a version.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { runGenerationJob } from '@mcp/sprite-studio/jobs/job-runner.js';
import { promoteCandidate, candidateFileName } from '@mcp/sprite-studio/jobs/pick-candidate.js';
import type { SpriteGenerationJobParams } from '@mcp/sprite-studio/jobs/generation-request.js';
import { resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import type { ServerDeps } from '../../deps.js';
import { buildSpriteJobDeps, spriteScratchDir, makeProjectRootResolver } from './job-deps.js';
import { persistJobSheet } from './sheet-artifact.js';
import {
  buildEditJobParams, buildGenerationRefs, editKindOf, editRequestSnapshot,
  type GenerateRouteBody,
} from './generate-body.js';
import { getSpriteJobQueue } from './queue-singleton.js';
import { emitSpriteEvent } from './bus-registry.js';
import { toVersionDto } from './mappers.js';

export function mountSpriteGenerateRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteFileStore;

  app.post('/api/sprite-studio/projects/:projectId/generate', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const project = await store.projectByIdeId(ideProjectId);
    if (!project) return c.json({ error: 'not_initialized' }, 404);
    const body = (await c.req.json().catch(() => null)) as GenerateRouteBody | null;
    if (!body?.prompt) return c.json({ error: 'invalid_body' }, 400);

    // Edit flows (selection inpaint / whole-image enhance): img2img of one
    // existing version — its PNG is read from the repo and rides as the
    // reference image; the capability filter routes to edit/mask-capable links.
    const editKind = editKindOf(body);
    if (editKind) {
      if (!body.assetId || !body.versionId) return c.json({ error: 'invalid_body' }, 400);
      const version = await store.getVersion(body.versionId);
      const root = deps.db.getProject(ideProjectId)?.root_path;
      if (!version || version.asset_id !== body.assetId || !root) {
        return c.json({ error: 'not_found' }, 404);
      }
      let png: Buffer;
      try {
        png = fs.readFileSync(resolveInsideSpriteDir(root, version.file_rel_path));
      } catch {
        return c.json({ error: 'version_file_missing' }, 404);
      }
      const jobRow = await store.insertJob({
        sprite_project_id: project.id,
        asset_id: body.assetId,
        kind: 'edit',
        user_intent: body.prompt,
        request: editRequestSnapshot(editKind, body),
      });
      const jobDeps = buildSpriteJobDeps(deps, project.id);
      const params = buildEditJobParams(body, project.style, png);
      getSpriteJobQueue().enqueue(project.id, jobRow.id, (signal) =>
        runGenerationJob(jobDeps, jobRow, params, signal),
      );
      return c.json({ jobId: jobRow.id });
    }

    // Reference conditioning (the Gemini/ChatGPT-web fidelity path): current
    // version as identity anchor + library versions + disk uploads, capped.
    // Versions are validated to belong to THIS sprite project.
    const root = deps.db.getProject(ideProjectId)?.root_path ?? null;
    const readVersionPng = async (versionId: string): Promise<Buffer | null> => {
      const v = await store.getVersion(versionId);
      if (!v || !root) return null;
      const owner = await store.getAsset(v.asset_id);
      if (!owner || owner.sprite_project_id !== project.id) return null;
      try { return fs.readFileSync(resolveInsideSpriteDir(root, v.file_rel_path)); } catch { return null; }
    };
    const currentVersionId = body.assetId
      ? (await store.getAsset(body.assetId))?.current_version_id ?? null
      : null;
    const refs = await buildGenerationRefs(body, readVersionPng, currentVersionId);

    const jobRow = await store.insertJob({
      sprite_project_id: project.id,
      asset_id: body.assetId ?? null,
      kind: 'generate',
      user_intent: body.prompt,
      // Request snapshot: lets the UI rehydrate a job (n → expected variant
      // count) after navigation/restart, and is provenance for the ledger.
      request: {
        n: Math.max(1, Math.min(8, body.n ?? 1)),
        rawPrompt: !!body.rawPrompt,
        seed: body.seed ?? null,
        refCount: refs.length,
        useCurrentAsRef: !!body.useCurrentAsRef,
      },
    });

    const params: SpriteGenerationJobParams = {
      intent: body.prompt,
      style: project.style,
      n: Math.max(1, Math.min(8, body.n ?? 1)),
      rawPrompt: body.rawPrompt,
      seed: body.seed ?? undefined,
      ...(refs.length > 0 ? { referenceImages: refs } : {}),
    };
    const jobDeps = buildSpriteJobDeps(deps, project.id);
    getSpriteJobQueue().enqueue(project.id, jobRow.id, (signal) =>
      runGenerationJob(jobDeps, jobRow, params, signal),
    );
    return c.json({ jobId: jobRow.id });
  });

  app.get('/api/sprite-studio/projects/:projectId/jobs', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const project = await store.projectByIdeId(ideProjectId);
    if (!project) return c.json({ jobs: [] });
    return c.json({ jobs: await store.listJobs(project.id, 50) });
  });

  app.post('/api/sprite-studio/jobs/:id/cancel', async (c) => {
    const jobId = c.req.param('id');
    const found = getSpriteJobQueue().cancel(jobId);
    if (!found) {
      // Not in the queue (already finished or unknown) — mark cancelled best-effort.
      const row = await store.getJob(jobId);
      if (row && !['done', 'failed', 'cancelled'].includes(row.status)) {
        await store.updateJobStatus(jobId, 'cancelled');
        emitSpriteEvent(row.sprite_project_id, { type: 'sprite_job', jobId, status: 'cancelled' });
      }
    }
    return c.json({ ok: true });
  });

  // Job rehydration: row + the staged candidates that exist on disk. The UI
  // calls this when remounting the generate panel so an in-flight (or
  // finished-but-unpicked) generation is never "lost" by navigation — the
  // work already happened and the PNGs are in the scratch dir.
  app.get('/api/sprite-studio/jobs/:id', async (c) => {
    const jobId = c.req.param('id');
    const row = await store.getJob(jobId);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const candidates: Array<{ index: number; candidateId: string }> = [];
    try {
      for (const name of fs.readdirSync(spriteScratchDir(jobId))) {
        const m = /^candidate-(\d+)\.png$/.exec(name);
        if (m) candidates.push({ index: Number(m[1]), candidateId: `candidate-${m[1]}` });
      }
      candidates.sort((a, b) => a.index - b.index);
    } catch {
      /* no scratch dir yet (queued/prompting) — empty list */
    }
    return c.json({
      job: {
        id: row.id, status: row.status, kind: row.kind,
        userIntent: row.user_intent, request: row.request,
        error: row.error, resultVersionId: row.result_version_id,
        assetId: row.asset_id, createdAt: row.created_at,
      },
      candidates,
    });
  });

  // Staged candidate preview (before promotion). Served straight from scratch.
  app.get('/api/sprite-studio/jobs/:id/candidates/:i/thumb', (c) => {
    const jobId = c.req.param('id');
    const i = Number(c.req.param('i'));
    const file = path.join(spriteScratchDir(jobId), candidateFileName(i));
    let png: Buffer;
    try { png = fs.readFileSync(file); } catch { return c.json({ error: 'not_found' }, 404); }
    return c.body(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
  });

  // Promote a staged candidate into an immutable asset version.
  app.post('/api/sprite-studio/projects/:projectId/assets/:assetId/pick', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const project = await store.projectByIdeId(ideProjectId);
    const asset = await store.getAsset(c.req.param('assetId'));
    if (!project || !asset) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { jobId?: string; candidateIndex?: number } | null;
    if (!body?.jobId || body.candidateIndex == null) return c.json({ error: 'invalid_body' }, 400);
    try {
      const version = await promoteCandidate(
        {
          stores: buildSpriteJobDeps(deps, project.id).stores,
          scratchDir: spriteScratchDir,
          projectRoot: makeProjectRootResolver(deps),
        },
        { jobId: body.jobId, candidateIndex: body.candidateIndex, asset: { id: asset.id, slug: asset.slug } },
      );
      // Keep the packed variation's original sheet durably (re-sliceable later).
      const root = deps.db.getProject(ideProjectId)?.root_path;
      if (root) persistJobSheet(root, asset.slug, body.jobId);
      const persisted = await store.getVersion(version.id);
      if (!persisted) throw new Error('promoted_version_missing');
      return c.json(toVersionDto(ideProjectId, persisted));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
}
