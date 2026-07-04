/**
 * writeEditedVersion — the core of "save a PNG as a new immutable version":
 * repo file (`v%03d.png`) + manifest entry + DB mirror row, optionally moving
 * the asset's current-version pointer. Extracted from the multipart POST in
 * assets.routes.ts so server-side flows (frame alignment) reuse the exact
 * same write path instead of mirroring it.
 *
 * Note: appendVersion always points the MANIFEST's currentVersion at the new
 * entry (its contract) — `setCurrent:false` only leaves the DB pointer alone,
 * the same trade-off promoteFrames already makes for animation frames.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendVersion, readAssetManifest, removeVersion, updateVersionEntry,
} from '@mcp/sprite-studio/repo/manifest.js';
import { resolveInsideSpriteDir, versionFileName } from '@mcp/sprite-studio/repo/paths.js';
import { decodePng } from '@mcp/sprite-studio/processing/png.js';
import type { SpriteAssetVersionRow, SpriteVersionSource } from '@mcp/store/sprite-studio/types.js';
import type { ServerDeps } from '../../deps.js';

export interface WriteEditedVersionOpts {
  /** Move the asset's current_version_id to the new version (default true). */
  setCurrent?: boolean;
  /** Provenance: the version this one was derived from (e.g. alignment). */
  parentVersionId?: number | null;
  /** Version provenance kind (default 'edited'; sheet import passes 'imported'). */
  source?: SpriteVersionSource;
}

/**
 * Overwrite an EXISTING version in place: same version number, same
 * `v%03d.png` file — new bytes. The focused frame-edit "Salvar Sprite" flow:
 * every frame pointing at this version updates visually without a new row.
 * Writes file → manifest entry (hash/createdAt) → DB row (dims/hash/source).
 */
export function overwriteVersion(
  deps: ServerDeps,
  root: string,
  asset: { id: number; slug: string },
  version: { id: number; version: number; file_rel_path: string },
  png: Buffer,
): SpriteAssetVersionRow {
  const store = deps.spriteAssetsStore;
  const { width, height } = decodePng(png);
  const hash = crypto.createHash('sha256').update(png).digest('hex');
  const abs = resolveInsideSpriteDir(root, version.file_rel_path);
  fs.writeFileSync(abs, png);
  updateVersionEntry(root, asset.slug, version.version, {
    hash,
    createdAt: new Date().toISOString(),
  });
  const row = store.updateVersionContent(version.id, { width, height, content_hash: hash });
  if (!row) throw new Error('version_row_missing');
  return row;
}

/**
 * Curation delete of one version's repo side: the PNG file + its manifest
 * entry (best-effort — a failed unlink never blocks the DB delete; resync
 * reconciles). The DB row is the caller's responsibility. Shared by the
 * single-version and bulk-version delete routes so both purge identically.
 */
export function purgeVersionFile(
  root: string,
  asset: { slug: string } | null,
  version: { file_rel_path: string; version: number },
): void {
  try {
    fs.rmSync(resolveInsideSpriteDir(root, version.file_rel_path), { force: true });
  } catch {
    /* best effort — repo is the mirror, DB is authoritative here */
  }
  if (asset) removeVersion(root, asset.slug, version.version);
}

/** Throws Error('no_manifest') when the asset has no repo manifest. */
export function writeEditedVersion(
  deps: ServerDeps,
  root: string,
  asset: { id: number; slug: string },
  png: Buffer,
  opts: WriteEditedVersionOpts = {},
): SpriteAssetVersionRow {
  const store = deps.spriteAssetsStore;
  const manifest = readAssetManifest(root, asset.slug);
  if (!manifest) throw new Error('no_manifest');
  const source = opts.source ?? 'edited';
  const { width, height } = decodePng(png);
  const hash = crypto.createHash('sha256').update(png).digest('hex');
  const v = store.nextVersionNumber(asset.id);
  const fileName = versionFileName(v);
  const relPath = `assets/${asset.slug}/${fileName}`;
  const abs = resolveInsideSpriteDir(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, png);
  const parentRow = opts.parentVersionId != null ? store.getVersion(opts.parentVersionId) : null;
  appendVersion(root, asset.slug, {
    v, file: fileName, source, hash,
    ...(parentRow ? { parent: parentRow.version } : {}),
    createdAt: new Date().toISOString(),
  });
  const row = store.insertVersion({
    asset_id: asset.id, version: v, file_rel_path: relPath, width, height,
    source, content_hash: hash,
    parent_version_id: opts.parentVersionId ?? null,
  });
  if (opts.setCurrent !== false) store.setCurrentVersion(asset.id, row.id);
  return row;
}
