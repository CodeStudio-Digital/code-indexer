/**
 * Rebuild the DB mirror from the repo manifests (plan §2.3): the files in
 * `.sprite-studio/` are the source of truth. Every asset manifest on disk is
 * upserted; mirror rows whose slug no longer has a manifest are marked
 * 'missing' (never deleted — history/jobs may still reference them).
 */
import fs from 'node:fs';
import path from 'node:path';
import { assetsRootDir } from '@mcp/sprite-studio/repo/paths.js';
import { readAssetManifest } from '@mcp/sprite-studio/repo/manifest.js';
import type { SpriteAssetStatus } from '@mcp/store/sprite-studio/types.js';
import type { ServerDeps } from '../../deps.js';

export function resyncSpriteProject(deps: ServerDeps, spriteProjectId: number, root: string): void {
  const store = deps.spriteAssetsStore;
  const dir = assetsRootDir(root);
  const slugsOnDisk = new Set<string>();

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = []; // no assets/ dir yet → all existing rows become 'missing'
  }

  const existing = new Map(store.list(spriteProjectId).map((a) => [a.slug, a]));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = readAssetManifest(root, entry.name);
    if (!manifest) continue;
    slugsOnDisk.add(entry.name);
    const status = (manifest.status || 'draft') as SpriteAssetStatus;
    let row = existing.get(entry.name);
    if (!row) {
      row = store.create({
        sprite_project_id: spriteProjectId,
        slug: entry.name,
        display_name: manifest.displayName,
        category: manifest.category,
        tags: manifest.tags,
        status,
      });
    } else {
      store.updateMeta(row.id, {
        display_name: manifest.displayName,
        category: manifest.category,
        tags: manifest.tags,
        status,
      });
    }
    reconcileVersions(store, row.id, root, entry.name, manifest.versions);
  }

  // Rows whose repo dir/manifest vanished → 'missing' (kept for provenance).
  for (const [slug, row] of existing) {
    if (!slugsOnDisk.has(slug) && row.status !== 'missing') {
      store.updateMeta(row.id, { status: 'missing' });
    }
  }
}

function reconcileVersions(
  store: ServerDeps['spriteAssetsStore'],
  assetId: number,
  root: string,
  slug: string,
  versions: Array<{ v: number; file: string; source: string; prompt?: string; hash?: string }>,
): void {
  const known = new Set(store.listVersions(assetId).map((v) => v.version));
  let current: number | null = null;
  for (const entry of versions) {
    if (known.has(entry.v)) continue;
    const abs = path.join(assetsRootDir(root), slug, entry.file);
    let width: number | null = null;
    let height: number | null = null;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
    } catch {
      continue; // manifest lists a file that isn't on disk — skip
    }
    const row = store.insertVersion({
      asset_id: assetId,
      version: entry.v,
      file_rel_path: `assets/${slug}/${entry.file}`,
      width,
      height,
      source: 'imported',
      prompt: entry.prompt ?? null,
      content_hash: entry.hash ?? null,
    });
    current = row.id;
  }
  if (current !== null) store.setCurrentVersion(assetId, current);
}
