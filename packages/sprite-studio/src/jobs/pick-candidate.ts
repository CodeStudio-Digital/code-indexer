/**
 * Promote a staged job candidate into a real, immutable asset version
 * (staged-variants flow, plan §2.6 item 3): read the candidate PNG from the
 * job scratch dir, write `v%03d.png` into the repo, append the manifest
 * entry (repo = source of truth) and mirror it as a version row. Also the
 * autoSave path of the runner (candidateIndex 0).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SpriteAssetsStore } from '@mcp/store/sprite-studio/sprite-assets-store.js';
import type { SpriteAssetVersionRow } from '@mcp/store/sprite-studio/types.js';
import type { SpriteJobsStore } from '@mcp/store/sprite-studio/sprite-jobs-store.js';
import { decodePng } from '../processing/png.js';
import { appendVersion, nextVersionNumber, readAssetManifest } from '../repo/manifest.js';
import { resolveInsideSpriteDir, versionFileName } from '../repo/paths.js';

export interface PickDeps {
  stores: { assets: SpriteAssetsStore; jobs: SpriteJobsStore };
  scratchDir(jobId: number): string;
  projectRoot(spriteProjectId: number): Promise<string> | string;
  now?(): string;
}

export interface PromoteCandidateInput {
  jobId: number;
  candidateIndex: number;
  /** Target asset: DB row id + repo slug (asset must already exist). */
  asset: { id: number; slug: string };
}

/** Scratch file basename for candidate `i` (matches the runner's writes). */
export function candidateFileName(index: number): string {
  return `candidate-${index}.png`;
}

export async function promoteCandidate(
  deps: PickDeps,
  input: PromoteCandidateInput,
): Promise<SpriteAssetVersionRow> {
  const { jobId, candidateIndex, asset } = input;
  const candidateFile = path.join(deps.scratchDir(jobId), candidateFileName(candidateIndex));
  const png = fs.readFileSync(candidateFile);
  const { width, height } = decodePng(png);
  const contentHash = crypto.createHash('sha256').update(png).digest('hex');

  const job = deps.stores.jobs.get(jobId);
  if (!job) throw new Error(`Unknown sprite job ${jobId}`);
  const projectRoot = await deps.projectRoot(job.sprite_project_id);

  const manifest = readAssetManifest(projectRoot, asset.slug);
  if (!manifest) {
    throw new Error(`No asset manifest for slug "${asset.slug}" — create the asset first`);
  }
  const v = nextVersionNumber(manifest);
  const fileName = versionFileName(v);
  const relPath = `assets/${asset.slug}/${fileName}`; // relative to .sprite-studio/
  const absPath = resolveInsideSpriteDir(projectRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, png);

  appendVersion(projectRoot, asset.slug, {
    v,
    file: fileName,
    source: 'generated',
    prompt: job.expanded_prompt ?? undefined,
    userIntent: job.user_intent ?? undefined,
    genParams: job.request ?? undefined,
    hash: contentHash,
    createdAt: deps.now?.() ?? new Date().toISOString(),
  });

  const row = deps.stores.assets.insertVersion({
    asset_id: asset.id,
    version: v,
    file_rel_path: relPath,
    width,
    height,
    source: 'generated',
    prompt: job.expanded_prompt ?? null,
    user_intent: job.user_intent ?? null,
    gen_params: job.request ?? null,
    job_id: jobId,
    content_hash: contentHash,
  });
  deps.stores.assets.setCurrentVersion(asset.id, row.id);
  deps.stores.jobs.setResult(jobId, { result_version_id: row.id });
  return row;
}
