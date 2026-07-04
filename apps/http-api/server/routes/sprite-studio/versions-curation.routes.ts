/**
 * Sprite Studio — version curation + grouping (split from assets.routes.ts for
 * the 200-LOC ceiling; both back the Frames browser).
 *
 *   GET  /projects/:projectId/assets/:assetId/generations
 *        versions grouped by generation batch (job_id), with the job's
 *        animation name resolved ("job#40 · idle · 6f"); job_id NULL rows fold
 *        into one 'manual' bucket.
 *   POST /projects/:projectId/versions/bulk-delete
 *        curation-delete many versions at once (repo files + DB rows), and
 *        report which animations lost frame pointers so the UI can warn.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { toGenerationGroupDto, toVersionDto } from './mappers.js';
import { hasJobSheet } from './sheet-artifact.js';
import { overwriteVersion, purgeVersionFile } from './version-write.js';

const MAX_BULK = 200;

export function mountSpriteVersionCurationRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteAssetsStore;

  app.get('/api/sprite-studio/projects/:projectId/assets/:assetId/generations', (c) => {
    const assetId = Number(c.req.param('assetId'));
    const asset = store.get(assetId);
    if (!asset) return c.json({ generations: [] });
    const root = deps.db.getProject(Number(c.req.param('projectId')))?.root_path ?? null;
    const generations = store.listVersionGroups(assetId).map((g) => {
      const job = g.jobId != null ? deps.spriteJobsStore.get(g.jobId) : null;
      const animId =
        job?.request && typeof job.request.animation_id === 'number' ? job.request.animation_id : null;
      // Tolerate a deleted animation → animationName null, group still shown.
      const animName = animId != null ? deps.spriteAnimationsStore.get(animId)?.name ?? null : null;
      const sheet = g.jobId != null && root != null && hasJobSheet(root, asset.slug, g.jobId);
      return toGenerationGroupDto(g, job, animName, sheet);
    });
    return c.json({ generations });
  });

  // In-place overwrite (focused frame edit "Salvar Sprite"): same version
  // number + file, new bytes — frames pointing at it update without a new row.
  app.put('/api/sprite-studio/projects/:projectId/versions/:versionId/file', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const root = deps.db.getProject(ideProjectId)?.root_path ?? null;
    const version = store.getVersion(Number(c.req.param('versionId')));
    const asset = version ? store.get(version.asset_id) : null;
    if (!root || !version || !asset) return c.json({ error: 'not_found' }, 404);
    let png: Buffer;
    try {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return c.json({ error: 'no_file' }, 400);
      png = Buffer.from(await file.arrayBuffer());
    } catch {
      return c.json({ error: 'invalid_multipart' }, 400);
    }
    try {
      const row = overwriteVersion(deps, root, asset, version, png);
      return c.json(toVersionDto(ideProjectId, row));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post('/api/sprite-studio/projects/:projectId/versions/bulk-delete', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const root = deps.db.getProject(ideProjectId)?.root_path ?? null;
    if (!root) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { versionIds?: unknown } | null;
    const ids = Array.isArray(body?.versionIds)
      ? [...new Set((body?.versionIds as unknown[]).filter((x): x is number => Number.isInteger(x)))].slice(0, MAX_BULK)
      : [];
    if (ids.length === 0) return c.json({ error: 'invalid_body' }, 400);

    // Purge repo files (best-effort) for the known versions BEFORE the atomic
    // DB delete — the DB rows still exist, so deleteVersions still finds them.
    for (const id of ids) {
      const v = store.getVersion(id);
      if (v) purgeVersionFile(root, store.get(v.asset_id), v);
    }
    const res = store.deleteVersions(ids);
    const affectedAnimations = Object.entries(res.framesByAnimation).map(([animId, removedFrames]) => ({
      id: Number(animId),
      name: deps.spriteAnimationsStore.get(Number(animId))?.name ?? '',
      removedFrames,
    }));
    return c.json({ deleted: res.deleted, missing: res.missing, affectedAnimations });
  });
}
