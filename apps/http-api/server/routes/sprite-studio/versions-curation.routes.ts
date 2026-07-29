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
import fs from 'node:fs';
import type { Hono } from 'hono';
import { removeVersions } from '@mcp/sprite-studio/repo/manifest.js';
import { resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import type { ServerDeps } from '../../deps.js';
import { toGenerationGroupDto, toVersionDto } from './mappers.js';
import { hasJobSheet } from './sheet-artifact.js';
import { overwriteVersion } from './version-write.js';

const MAX_BULK = 200;

export function mountSpriteVersionCurationRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteFileStore;

  app.get('/api/sprite-studio/projects/:projectId/assets/:assetId/generations', async (c) => {
    const assetId = c.req.param('assetId');
    const asset = await store.getAsset(assetId);
    if (!asset) return c.json({ generations: [] });
    const root = deps.db.getProject(Number(c.req.param('projectId')))?.root_path ?? null;
    const generations = await Promise.all(
      (await store.listVersionGroups(assetId)).map(async (g) => {
      const job = g.jobId != null ? await store.getJob(g.jobId) : null;
      const animId =
        job?.request && typeof job.request.animation_id === 'string'
          ? job.request.animation_id
          : null;
      // Tolerate a deleted animation → animationName null, group still shown.
      const animName =
        animId != null ? (await store.getAnimation(animId))?.name ?? null : null;
      const sheet = g.jobId != null && root != null && hasJobSheet(root, asset.slug, g.jobId);
      return toGenerationGroupDto(g, job, animName, sheet);
    }));
    return c.json({ generations });
  });

  // In-place overwrite (focused frame edit "Salvar Sprite"): same version
  // number + file, new bytes — frames pointing at it update without a new row.
  app.put('/api/sprite-studio/projects/:projectId/versions/:versionId/file', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const root = deps.db.getProject(ideProjectId)?.root_path ?? null;
    const version = await store.getVersion(c.req.param('versionId'));
    const asset = version ? await store.getAsset(version.asset_id) : null;
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
      const row = await overwriteVersion(deps, root, asset, version, png);
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
      ? [...new Set((body?.versionIds as unknown[]).filter((x): x is string => typeof x === 'string'))].slice(0, MAX_BULK)
      : [];
    if (ids.length === 0) return c.json({ error: 'invalid_body' }, 400);

    // Purge repo files + manifest entries (best-effort) BEFORE the atomic DB
    // delete — the DB rows still exist, so deleteVersions still finds them.
    // Files unlink per version, but each asset's manifest is rewritten ONCE
    // (removeVersions) — the per-version rewrite was O(n²) sync IO on main.
    const byAsset = new Map<string, { slug: string | null; vs: number[] }>();
    for (const id of ids) {
      const v = await store.getVersion(id);
      if (!v) continue;
      try {
        fs.rmSync(resolveInsideSpriteDir(root, v.file_rel_path), { force: true });
      } catch {
        /* best effort — repo is the mirror, DB is authoritative here */
      }
      let entry = byAsset.get(v.asset_id);
      if (!entry) {
        entry = {
          slug: (await store.getAsset(v.asset_id))?.slug ?? null,
          vs: [],
        };
        byAsset.set(v.asset_id, entry);
      }
      entry.vs.push(v.version);
    }
    for (const { slug, vs } of byAsset.values()) {
      if (!slug) continue;
      try {
        removeVersions(root, slug, vs);
      } catch {
        // Best effort — a corrupt asset.json or a locked rename (Windows AV)
        // must not 500 AFTER the files were already unlinked, leaving DB rows
        // pointing at nothing. The DB delete below is authoritative; resync
        // reconciles a stale manifest.
      }
    }
    const res = await store.deleteVersions(ids);
    const affectedAnimations = await Promise.all(
      Object.entries(res.framesByAnimation).map(async ([animId, removedFrames]) => ({
        id: animId,
        name: (await store.getAnimation(animId))?.name ?? '',
        removedFrames,
      })),
    );
    return c.json({ deleted: res.deleted, missing: res.missing, affectedAnimations });
  });
}
