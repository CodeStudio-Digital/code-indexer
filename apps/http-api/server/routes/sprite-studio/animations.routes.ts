/**
 * Sprite Studio — animation timeline routes (F2 MVP).
 *
 *   GET/POST /projects/:projectId/assets/:assetId/animations   list / create
 *   PATCH/DELETE /animations/:id                                fps/loop / remove
 *   POST  /animations/:id/frames/generate   frame-pack generation job (n×1 grid;
 *         the anchor version — body anchorVersionId, validated against the
 *         asset, or the asset's current — is the character reference; an
 *         explicit anchor persists into settings_json for provenance)
 *   POST  /animations/:id/frames/adopt      promote ALL staged candidates of a
 *         finished job → versions + frame rows (replaces existing frames) and
 *         record settings_json.lastGenJobId
 *   PATCH /animations/:id/frames            replace one track's cells
 *   (GIF preview lives in gif.routes.ts; track CRUD in tracks.routes.ts)
 *
 * Generation stays two-step (generate → adopt) so the job runner is untouched:
 * the frontend watches the job over SSE and calls adopt on completion.
 */
import fs from 'node:fs';
import type { Hono } from 'hono';
import { actionSpec, SPRITE_ACTION_CATALOG } from '@mcp/sprite-studio/jobs/action-catalog.js';
import { buildAnimationIntent } from '@mcp/sprite-studio/jobs/animation-prompt.js';
import type { SpriteGenerationJobParams } from '@mcp/sprite-studio/jobs/generation-request.js';
import { runGenerationJob } from '@mcp/sprite-studio/jobs/job-runner.js';
import { promoteFrames } from '@mcp/sprite-studio/jobs/promote-frames.js';
import { resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import type { SpriteLoopMode } from '@mcp/store/sprite-studio/types.js';
import { normalizeTracks } from '@mcp/store/sprite-studio/track-settings.js';
import type { ServerDeps } from '../../deps.js';
import {
  clampFps, clampFrames, LOOP_MODES, pickAnchorVersion, resolveAnim, toAnimDto,
} from './animation-helpers.js';
import { buildSpriteJobDeps, makeProjectRootResolver, spriteScratchDir } from './job-deps.js';
import { persistJobSheet } from './sheet-artifact.js';
import { getSpriteJobQueue } from './queue-singleton.js';
import { writeEditedVersion } from './version-write.js';

export function mountSpriteAnimationRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteFileStore;
  const dto = async (anim: NonNullable<Awaited<ReturnType<typeof store.getAnimation>>>) =>
    toAnimDto(anim, await store.listFrames(anim.id));

  app.get('/api/sprite-studio/animation-actions', (c) => c.json({
    actions: SPRITE_ACTION_CATALOG.map(({ phrase: _phrase, ...action }) => action),
    directions: ['S', 'N', 'E', 'W', 'SE', 'SW', 'NE', 'NW', 'side'],
  }));

  app.get('/api/sprite-studio/projects/:projectId/assets/:assetId/animations', async (c) => {
    const assetId = c.req.param('assetId');
    if (!await store.getAsset(assetId)) return c.json({ animations: [] });
    return c.json({
      animations: await Promise.all(
        (await store.listAnimations(assetId)).map(dto),
      ),
    });
  });

  app.post('/api/sprite-studio/projects/:projectId/assets/:assetId/animations', async (c) => {
    const assetId = c.req.param('assetId');
    if (!await store.getAsset(assetId)) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as
      | { name?: string; fps?: number; frames?: number; loopMode?: SpriteLoopMode;
          actionKey?: string; direction?: string; exportName?: string }
      | null;
    const name = body?.name?.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40);
    if (!name) return c.json({ error: 'invalid_body' }, 400);
    const spec = actionSpec(name);
    try {
      const anim = await store.createAnimation({
        asset_id: assetId,
        name,
        fps: clampFps(body?.fps, spec?.fps ?? 8),
        loop_mode: body?.loopMode && LOOP_MODES.has(body.loopMode) ? body.loopMode : spec?.loopMode ?? 'loop',
        settings: {
          frameCount: clampFrames(body?.frames, spec?.frames ?? 4),
          actionKey: body?.actionKey?.trim() || spec?.action || name,
          direction: body?.direction?.trim() || undefined,
          exportName: body?.exportName?.trim().replace(/\s+/g, '_').slice(0, 60) || name,
          pivot: { x: 0.5, y: 1 },
        },
      });
      return c.json(await dto(anim));
    } catch {
      return c.json({ error: 'name_taken' }, 409); // UNIQUE(asset_id, name)
    }
  });

  app.patch('/api/sprite-studio/animations/:id', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      fps?: number; loopMode?: string; frameCount?: number;
      loopStart?: number | null; loopEnd?: number | null;
      actionKey?: string; direction?: string | null; exportName?: string; pivot?: { x?: number; y?: number };
    };
    // Fold frameCount + loop markers into a single settings_json patch. A
    // null loop marker clears it (undefined key is dropped by JSON.stringify).
    const settings = { ...found.anim.settings };
    let touched = false;
    const clampIdx = (v: number | null | undefined): number | undefined =>
      v == null ? undefined : Math.max(0, Math.round(Number(v)));
    if (body.frameCount !== undefined) { settings.frameCount = clampFrames(body.frameCount, 4); touched = true; }
    if (body.loopStart !== undefined) { settings.loopStart = clampIdx(body.loopStart); touched = true; }
    if (body.loopEnd !== undefined) { settings.loopEnd = clampIdx(body.loopEnd); touched = true; }
    if (body.actionKey !== undefined) { settings.actionKey = body.actionKey.trim().slice(0, 40); touched = true; }
    if (body.direction !== undefined) { settings.direction = body.direction?.trim() || undefined; touched = true; }
    if (body.exportName !== undefined) { settings.exportName = body.exportName.trim().replace(/\s+/g, '_').slice(0, 60); touched = true; }
    if (body.pivot !== undefined) {
      settings.pivot = {
        x: Math.max(0, Math.min(1, Number(body.pivot.x) || 0)),
        y: Math.max(0, Math.min(1, Number(body.pivot.y) || 0)),
      };
      touched = true;
    }
    const updated = await store.updateAnimation(found.anim.id, {
      fps: body.fps !== undefined ? clampFps(body.fps, found.anim.fps) : undefined,
      loop_mode: typeof body.loopMode === 'string' && LOOP_MODES.has(body.loopMode)
        ? (body.loopMode as SpriteLoopMode) : undefined,
      settings: touched ? settings : undefined,
    });
    return c.json(await dto(updated!));
  });

  // Frames rows go too; the version files/rows STAY (they are asset versions).
  app.delete('/api/sprite-studio/animations/:id', async (c) => {
    await store.deleteAnimation(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Enqueue a frame-pack generation: ONE n×1 grid image, sliced into staged
  // candidates. Adoption (below) is a separate call made when the job is done.
  app.post('/api/sprite-studio/animations/:id/frames/generate', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found || !found.root) return c.json({ error: 'not_found' }, 404);
    const { anim, asset, spriteProject, root } = found;
    const body = (await c.req.json().catch(() => ({}))) as
      { intent?: string; direction?: string; anchorVersionId?: string; frameCount?: number };
    // Frame count: an explicit body.frameCount (the GenerateBar stepper) wins
    // and is persisted so a later regen/rehydrate keeps it; otherwise fall back
    // to the animation's stored target (or the current frame count).
    const n = body.frameCount !== undefined
      ? clampFrames(body.frameCount, typeof anim.settings.frameCount === 'number' ? anim.settings.frameCount : 4)
      : clampFrames(anim.settings.frameCount, (await store.listFrames(anim.id)).length || 4);
    if (body.frameCount !== undefined) {
      await store.mergeAnimationSettings(anim.id, { frameCount: n });
    }
    const direction = typeof body.direction === 'string'
      ? body.direction
      : typeof anim.settings.direction === 'string' ? anim.settings.direction : undefined;
    if (typeof body.direction === 'string') {
      await store.mergeAnimationSettings(anim.id, { direction: body.direction });
    }
    const intent = buildAnimationIntent(body.intent?.trim() || anim.name, n, direction);

    // Character consistency (layer B): the ANCHOR version conditions the pack
    // — an explicit body anchorVersionId (must belong to this asset) or the
    // asset's current version when omitted.
    const anchor = await pickAnchorVersion(
      (id) => store.getVersion(id),
      asset.id, asset.current_version_id, body.anchorVersionId,
    );
    if (!anchor.ok) return c.json({ error: 'invalid_anchor' }, 400);
    const referenceImages: SpriteGenerationJobParams['referenceImages'] = [];
    if (anchor.version) {
      try {
        const png = fs.readFileSync(resolveInsideSpriteDir(root, anchor.version.file_rel_path));
        referenceImages.push({ base64: png.toString('base64'), mediaType: 'image/png' });
      } catch { /* file missing → generate unconditioned rather than fail */ }
    }
    // Provenance: an explicitly chosen anchor sticks to the animation.
    if (anchor.explicit && anchor.version) {
      await store.mergeAnimationSettings(anim.id, {
        anchorVersionId: anchor.version.id,
      });
    }

    const jobRow = await store.insertJob({
      sprite_project_id: spriteProject.id,
      asset_id: asset.id,
      kind: 'generate',
      user_intent: intent,
      // animation_id is the adopt-time ownership check; n rehydrates the UI;
      // anchorVersionId snapshots the EFFECTIVE identity reference.
      request: {
        animation_id: anim.id, n, direction: direction ?? null,
        anchorVersionId: anchor.version?.id ?? null,
      },
    });
    const params: SpriteGenerationJobParams = {
      intent,
      style: spriteProject.style,
      n,
      packVariants: true,
      grid: { cols: n, rows: 1 },
      referenceImages: referenceImages.length ? referenceImages : undefined,
    };
    const jobDeps = buildSpriteJobDeps(deps, spriteProject.id);
    getSpriteJobQueue().enqueue(spriteProject.id, jobRow.id, (signal) =>
      runGenerationJob(jobDeps, jobRow, params, signal),
    );
    return c.json({ jobId: jobRow.id, n });
  });

  // Adopt a finished job's staged candidates as THE frame list (replace-all).
  app.post('/api/sprite-studio/animations/:id/frames/adopt', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { jobId?: string } | null;
    const job = body?.jobId != null ? await store.getJob(body.jobId) : null;
    if (!job) return c.json({ error: 'unknown_job' }, 400);
    if (job.request?.animation_id !== found.anim.id) return c.json({ error: 'job_animation_mismatch' }, 400);
    if (job.status !== 'done') return c.json({ error: 'job_not_done' }, 409);
    try {
      await promoteFrames(
        {
          stores: {
            ...buildSpriteJobDeps(deps, found.spriteProject.id).stores,
            animations: {
              replaceFrames: (animationId, frames) =>
                store.replaceFrames(animationId, frames),
            },
          },
          scratchDir: spriteScratchDir,
          projectRoot: makeProjectRootResolver(deps),
        },
        { jobId: job.id, animationId: found.anim.id, asset: { id: found.asset.id, slug: found.asset.slug } },
      );
      // Provenance: every current frame came from this job (frames also carry
      // per-version job_id — this is the animation-level shortcut).
      await store.mergeAnimationSettings(found.anim.id, {
        lastGenJobId: job.id,
      });
      // Keep the original combined sheet durably so it can be re-sliced later.
      if (found.root) persistJobSheet(found.root, found.asset.slug, job.id);
      return c.json(await dto((await store.getAnimation(found.anim.id))!));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Replace ONE track's cells (timeline edits; default = the base track).
  // Versions must belong to the animation's asset. Track 0 keeps the dense
  // 0..n-1 rewrite (legacy contract); overlay tracks honor EXPLICIT sparse
  // frameIndex values (an absent index is an empty cell of the shared grid).
  app.patch('/api/sprite-studio/animations/:id/frames', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as
      | { track?: number; frames?: Array<{ frameIndex?: number; versionId?: string; durationMs?: number | null }> }
      | null;
    if (!body?.frames || !Array.isArray(body.frames)) return c.json({ error: 'invalid_body' }, 400);
    const track = typeof body.track === 'number' ? Math.floor(body.track) : 0;
    if (!normalizeTracks(found.anim.settings).some((t) => t.id === track)) {
      return c.json({ error: 'unknown_track' }, 400);
    }
    const ordered = [...body.frames].sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0));
    const inputs: Array<{ frame_index: number; version_id: string; duration_ms: number | null }> = [];
    const seen = new Set<number>();
    for (const [i, f] of ordered.entries()) {
      const version = f.versionId != null ? await store.getVersion(f.versionId) : null;
      if (!version || version.asset_id !== found.asset.id) return c.json({ error: 'invalid_version' }, 400);
      // Durations live on the master line only (shared time grid).
      const ms = track === 0 && typeof f.durationMs === 'number'
        ? Math.max(20, Math.min(10_000, Math.round(f.durationMs)))
        : null;
      const idx = track === 0
        ? i
        : Math.max(0, Math.min(999, Math.floor(f.frameIndex ?? i)));
      if (seen.has(idx)) return c.json({ error: 'duplicate_frame_index' }, 400);
      seen.add(idx);
      inputs.push({ frame_index: idx, version_id: version.id, duration_ms: ms });
    }
    await store.replaceTrackFrames(found.anim.id, track, inputs);
    return c.json(await dto((await store.getAnimation(found.anim.id))!));
  });

  // Safe frame edit: create an immutable child version, then repoint only the
  // addressed timeline cell. Other clips/cells sharing the source stay intact.
  app.post('/api/sprite-studio/animations/:id/frames/:track/:index/version', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found?.root) return c.json({ error: 'not_found' }, 404);
    const track = Math.max(0, Math.floor(Number(c.req.param('track'))));
    const index = Math.max(0, Math.floor(Number(c.req.param('index'))));
    const cells = await store.listFrames(found.anim.id, track);
    const current = cells.find((cell) => cell.frame_index === index);
    if (!current) return c.json({ error: 'frame_not_found' }, 404);
    let png: Buffer;
    try {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return c.json({ error: 'no_file' }, 400);
      const expected = String(form.get('expectedVersionId') ?? '');
      if (expected && expected !== current.version_id) {
        return c.json({ error: 'frame_changed' }, 409);
      }
      png = Buffer.from(await file.arrayBuffer());
    } catch {
      return c.json({ error: 'invalid_multipart' }, 400);
    }
    try {
      const version = await writeEditedVersion(deps, found.root, found.asset, png, {
        setCurrent: false, parentVersionId: current.version_id, source: 'edited',
      });
      await store.replaceTrackFrames(found.anim.id, track, cells.map((cell) => ({
        frame_index: cell.frame_index,
        version_id: cell.frame_index === index ? version.id : cell.version_id,
        duration_ms: cell.duration_ms,
      })));
      return c.json({
        animation: await dto((await store.getAnimation(found.anim.id))!),
        versionId: version.id,
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  // GIF preview moved to gif.routes.ts (multi-track composite + LOC ceiling).
}
