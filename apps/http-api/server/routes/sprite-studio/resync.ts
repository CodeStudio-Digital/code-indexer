/**
 * Rebuild the per-session Sprite entity files from the repo manifests. Product
 * PNGs remain in `.sprite-studio/`; operational metadata is written only to
 * the owning session bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assetsRootDir } from '@mcp/sprite-studio/repo/paths.js';
import { readAssetManifest } from '@mcp/sprite-studio/repo/manifest.js';
import type { SpriteAssetStatus } from '@mcp/store/sprite-studio/types.js';
import type { ServerDeps } from '../../deps.js';

export async function resyncSpriteProject(
  deps: ServerDeps,
  spriteProjectId: string,
  root: string,
): Promise<void> {
  const store = deps.spriteFileStore;
  const dir = assetsRootDir(root);
  const slugsOnDisk = new Set<string>();

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = []; // no assets/ dir yet → all existing rows become 'missing'
  }

  const existing = new Map(
    (await store.listAssets(spriteProjectId)).map((asset) => [asset.slug, asset]),
  );

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = readAssetManifest(root, entry.name);
    if (!manifest) continue;
    slugsOnDisk.add(entry.name);
    const status = (manifest.status || 'draft') as SpriteAssetStatus;
    let row = existing.get(entry.name);
    if (!row) {
      row = await store.createAsset({
        sprite_project_id: spriteProjectId,
        slug: entry.name,
        display_name: manifest.displayName,
        category: manifest.category,
        tags: manifest.tags,
        status,
      });
    } else {
      await store.updateAsset(row.id, {
        display_name: manifest.displayName,
        category: manifest.category,
        tags: manifest.tags,
        status,
      });
    }
    await reconcileVersions(store, row.id, root, entry.name, manifest.versions);
  }

  // Rows whose repo dir/manifest vanished → 'missing' (kept for provenance).
  for (const [slug, row] of existing) {
    if (!slugsOnDisk.has(slug) && row.status !== 'missing') {
      await store.updateAsset(row.id, { status: 'missing' });
    }
  }
}

async function reconcileVersions(
  store: ServerDeps['spriteFileStore'],
  assetId: string,
  root: string,
  slug: string,
  versions: Array<{ v: number; file: string; source: string; prompt?: string; hash?: string }>,
): Promise<void> {
  const known = new Set((await store.listVersions(assetId)).map((v) => v.version));
  let current: string | null = null;
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
    const contentHash = createHash('sha256')
      .update(fs.readFileSync(abs))
      .digest('hex');
    const row = await store.insertVersion({
      asset_id: assetId,
      version: entry.v,
      file_rel_path: `assets/${slug}/${entry.file}`,
      width,
      height,
      source: 'imported',
      prompt: entry.prompt ?? null,
      content_hash: entry.hash && /^[0-9a-f]{64}$/i.test(entry.hash)
        ? entry.hash
        : contentHash,
    });
    current = row.id;
  }
  if (current !== null) await store.setCurrentVersion(assetId, current);
}
