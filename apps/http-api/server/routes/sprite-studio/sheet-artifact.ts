/**
 * Original-sheet artifact helpers. Packed generations (animation N×1 frame-packs
 * and Gerar-tab variation grids) keep their combined sheet in the job scratch
 * (`sheet.png`); when the batch is committed (adopt / pick) we copy it durably
 * into the repo at `assets/<slug>/sheets/job-<id>.png` so the user can re-slice
 * it later with a custom grid. Deterministic path ⇒ no DB row / no migration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import { spriteScratchDir } from './job-deps.js';

const sheetRel = (slug: string, jobId: number): string => `assets/${slug}/sheets/job-${jobId}.png`;

/** Absolute repo path of a job's persisted sheet (may not exist yet). */
export function sheetAbsPath(root: string, slug: string, jobId: number): string {
  return resolveInsideSpriteDir(root, sheetRel(slug, jobId));
}

/** True when a durable sheet exists for this job. */
export function hasJobSheet(root: string, slug: string, jobId: number): boolean {
  try {
    return fs.existsSync(sheetAbsPath(root, slug, jobId));
  } catch {
    return false;
  }
}

/**
 * Copy the job's scratch sheet into the repo (best-effort). No-op when the job
 * was a single-image (non-packed) generation, so there is no sheet to keep.
 */
export function persistJobSheet(root: string, slug: string, jobId: number): void {
  try {
    const src = path.join(spriteScratchDir(jobId), 'sheet.png');
    if (!fs.existsSync(src)) return;
    const dest = sheetAbsPath(root, slug, jobId);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch {
    /* best effort — the sheet is a convenience artifact, never load-bearing */
  }
}
