/**
 * Sprite Studio — asset + version routes. Assets create a repo manifest
 * (source of truth) and a mirror row; versions are served as PNG bytes from
 * the repo, thumbnails via the sprite worker's box-downscale.
 */
import fs from 'node:fs';
import type { Hono } from 'hono';
import { writeAssetManifest } from '@mcp/sprite-studio/repo/manifest.js';
import { assetDir, resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import { slugify, uniqueSlug } from '@mcp/sprite-studio/repo/slug.js';
import type { SpriteAssetStatus } from '@mcp/store/sprite-studio/types.js';
import type { ServerDeps } from '../../deps.js';
import { getSpriteWorkerClient } from '../../../sse/SpriteWorkerClient.js';
import { toAssetDto, toVersionDto } from './mappers.js';
import { purgeVersionFile, writeEditedVersion } from './version-write.js';

function ctx(deps: ServerDeps, c: { req: { param(k: string): string } }) {
  const ideProjectId = Number(c.req.param('projectId'));
  const project = deps.spriteProjectsStore.getByProjectId(ideProjectId);
  const root = deps.db.getProject(ideProjectId)?.root_path ?? null;
  return { ideProjectId, project, root };
}

export function mountSpriteAssetRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteAssetsStore;

  app.get('/api/sprite-studio/projects/:projectId/assets', (c) => {
    const { ideProjectId, project } = ctx(deps, c);
    if (!project) return c.json({ assets: [] });
    const category = c.req.query('category') || undefined;
    const q = c.req.query('q') || undefined;
    const size = { width: project.style.canvas.width, height: project.style.canvas.height };
    // `category` may be a comma list from the UI groups; filter in JS for that case.
    const wanted = category ? new Set(category.split(',')) : null;
    const rows = store.list(project.id, { q }).filter((a) => !wanted || wanted.has(a.category));
    return c.json({ assets: rows.map((r) => toAssetDto(ideProjectId, r, versionSize(store, r, size))) });
  });

  app.post('/api/sprite-studio/projects/:projectId/assets', async (c) => {
    const { ideProjectId, project, root } = ctx(deps, c);
    if (!project || !root) return c.json({ error: 'not_initialized' }, 404);
    const body = (await c.req.json().catch(() => null)) as
      | { name?: string; category?: string; width?: number; height?: number }
      | null;
    if (!body?.name) return c.json({ error: 'invalid_body' }, 400);
    const existing = new Set(store.list(project.id).map((a) => a.slug));
    const slug = uniqueSlug(slugify(body.name), (s) => existing.has(s));
    const category = body.category ?? 'misc';
    writeAssetManifest(root, slug, {
      slug, displayName: body.name, category, tags: [], status: 'draft', versions: [],
    });
    const row = store.create({ sprite_project_id: project.id, slug, display_name: body.name, category });
    const size = { width: body.width ?? project.style.canvas.width, height: body.height ?? project.style.canvas.height };
    return c.json(toAssetDto(ideProjectId, row, size));
  });

  app.patch('/api/sprite-studio/projects/:projectId/assets/:assetId', async (c) => {
    const { ideProjectId, project } = ctx(deps, c);
    if (!project) return c.json({ error: 'not_initialized' }, 404);
    const assetId = Number(c.req.param('assetId'));
    const patch = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    store.updateMeta(assetId, {
      display_name: typeof patch.name === 'string' ? patch.name : undefined,
      category: typeof patch.category === 'string' ? patch.category : undefined,
      tags: Array.isArray(patch.tags) ? (patch.tags as string[]) : undefined,
      status: typeof patch.status === 'string' ? (patch.status as SpriteAssetStatus) : undefined,
    });
    const row = store.get(assetId);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const size = { width: project.style.canvas.width, height: project.style.canvas.height };
    return c.json(toAssetDto(ideProjectId, row, versionSize(store, row, size)));
  });

  // Deleting an asset removes the repo directory too (the repo is the source
  // of truth — leaving the files would resurrect the asset on resync).
  app.delete('/api/sprite-studio/projects/:projectId/assets/:assetId', (c) => {
    const { root } = ctx(deps, c);
    const assetId = Number(c.req.param('assetId'));
    const asset = store.get(assetId);
    if (asset && root) {
      try { fs.rmSync(assetDir(root, asset.slug), { recursive: true, force: true }); } catch { /* best effort */ }
    }
    store.delete(assetId);
    return c.json({ ok: true });
  });

  // Curation delete of one version: repo file + manifest entry + mirror row.
  app.delete('/api/sprite-studio/projects/:projectId/versions/:versionId', (c) => {
    const { root } = ctx(deps, c);
    const versionId = Number(c.req.param('versionId'));
    const version = store.getVersion(versionId);
    if (!version || !root) return c.json({ error: 'not_found' }, 404);
    purgeVersionFile(root, store.get(version.asset_id), version);
    store.deleteVersion(versionId);
    return c.json({ ok: true });
  });

  app.get('/api/sprite-studio/projects/:projectId/assets/:assetId/versions', (c) => {
    const { ideProjectId } = ctx(deps, c);
    const assetId = Number(c.req.param('assetId'));
    return c.json({ versions: store.listVersions(assetId).map((v) => toVersionDto(ideProjectId, v)) });
  });

  // POST a hand-edited PNG (from the canvas editor) as a new immutable version.
  // Optional multipart field `setCurrent=false` skips moving the asset's
  // current pointer (derived versions, e.g. frame alignment, stay quiet).
  app.post('/api/sprite-studio/projects/:projectId/assets/:assetId/versions', async (c) => {
    const { ideProjectId, root } = ctx(deps, c);
    const assetId = Number(c.req.param('assetId'));
    const asset = store.get(assetId);
    if (!root || !asset) return c.json({ error: 'not_found' }, 404);
    let png: Buffer;
    let setCurrent = true;
    try {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return c.json({ error: 'no_file' }, 400);
      png = Buffer.from(await file.arrayBuffer());
      setCurrent = form.get('setCurrent') !== 'false';
    } catch {
      return c.json({ error: 'invalid_multipart' }, 400);
    }
    try {
      const rowV = writeEditedVersion(deps, root, asset, png, { setCurrent });
      return c.json(toVersionDto(ideProjectId, rowV));
    } catch (e) {
      const msg = (e as Error).message;
      return msg === 'no_manifest' ? c.json({ error: msg }, 404) : c.json({ error: msg }, 400);
    }
  });

  // Version bytes — full PNG.
  app.get('/api/sprite-studio/projects/:projectId/versions/:versionId/file', (c) => {
    const png = readVersionPng(deps, c);
    if (!png) return c.json({ error: 'not_found' }, 404);
    return pngResponse(c, png);
  });

  // Version thumbnail — box-downscaled off-thread by the sprite worker.
  app.get('/api/sprite-studio/projects/:projectId/versions/:versionId/thumb', async (c) => {
    const png = readVersionPng(deps, c);
    if (!png) return c.json({ error: 'not_found' }, 404);
    const s = Math.max(16, Math.min(512, Number(c.req.query('s')) || 128));
    try {
      const worker = getSpriteWorkerClient();
      const out = await worker.processPipeline(png.toString('base64'), [
        { op: 'resize', mode: 'box', width: s, height: s },
      ]);
      return pngResponse(c, Buffer.from(out.pngBase64, 'base64'));
    } catch {
      return pngResponse(c, png); // worker unavailable → serve full-res
    }
  });
}

function versionSize(
  store: ServerDeps['spriteAssetsStore'],
  asset: { current_version_id: number | null },
  fallback: { width: number; height: number },
): { width: number; height: number } {
  if (asset.current_version_id == null) return fallback;
  const v = store.getVersion(asset.current_version_id);
  return v?.width && v.height ? { width: v.width, height: v.height } : fallback;
}

function readVersionPng(deps: ServerDeps, c: { req: { param(k: string): string } }): Buffer | null {
  const ideProjectId = Number(c.req.param('projectId'));
  const versionId = Number(c.req.param('versionId'));
  const root = deps.db.getProject(ideProjectId)?.root_path;
  const version = deps.spriteAssetsStore.getVersion(versionId);
  if (!root || !version) return null;
  try {
    const abs = resolveInsideSpriteDir(root, version.file_rel_path);
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

function pngResponse(c: { body(b: BodyInit, init?: ResponseInit): Response }, png: Buffer): Response {
  return c.body(new Uint8Array(png), {
    headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=60' },
  });
}
