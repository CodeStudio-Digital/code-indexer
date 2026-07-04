/**
 * Generation job runner (plan §2.5/§2.6): walks
 * queued → prompting → generating → postprocess → done | failed | cancelled.
 *
 * Interactive jobs STAGE candidates in the scratch dir and finish with
 * `candidates[]` — no version rows until the user picks one. Agent jobs
 * (`params.autoSave`) add a 'saving' hop that promotes candidate 0 into a
 * repo version. Any throw lands in the terminal catch: cancelled when the
 * signal fired, failed (+ persisted error + sprite_job_failed) otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ImageGenClient, ImageGenResult } from '@mcp/provider-sdk/images.js';
import type { SpriteGenerationJobRow, SpriteJobStatus } from '@mcp/store/sprite-studio/types.js';
import type { ImageChainLink, SpriteJobDeps } from './deps.js';
import type { SpriteJobCandidateRef } from './events.js';
import {
  buildPostOps,
  buildRequest,
  linkSatisfies,
  type SpriteGenerationJobParams,
} from './generation-request.js';
import { stripDataUriPrefix } from '../processing/decode-image.js';
import { gridFor } from '../processing/slice.js';
import { buildGridSuffix } from './generation-request.js';
import { candidateFileName, promoteCandidate } from './pick-candidate.js';
import { estimateCost } from './pricing.js';
import { buildFinalPrompt, buildNegative } from './prompt-template.js';

export type { SpriteGenerationJobParams } from './generation-request.js';

interface Attempt {
  link: ImageChainLink;
  client: ImageGenClient;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error('Sprite job cancelled');
    err.name = 'AbortError';
    throw err;
  }
}

/** Try each capable link in order; transparent-capable links go first when wanted. */
async function generateWithFailover(
  deps: SpriteJobDeps,
  params: SpriteGenerationJobParams,
  prompt: string,
  negative: string,
  signal: AbortSignal | undefined,
): Promise<{ link: ImageChainLink; result: ImageGenResult; keyColorFlow: boolean; keyColor: string; size?: string; quality?: string }> {
  const chain = await deps.resolveImageChain();
  if (chain.length === 0) {
    throw new Error("No image provider bound for pipeline 'sprite-studio/image_gen'");
  }
  const errors: string[] = [];
  const attempts: Attempt[] = [];
  for (const link of chain) {
    try {
      attempts.push({ link, client: await deps.createImageClient(link.providerId, link.modelId) });
    } catch (err) {
      errors.push(`${link.providerId}/${link.modelId}: ${(err as Error).message}`);
    }
  }
  const capable = attempts.filter((a) => linkSatisfies(a.client.capabilities(), params));
  if (params.style.background === 'transparent') {
    // Stable partition: native-transparency links first, original order kept.
    capable.sort(
      (a, b) =>
        Number(b.client.capabilities().transparentBackground) -
        Number(a.client.capabilities().transparentBackground),
    );
  }
  if (capable.length === 0 && errors.length === 0) {
    errors.push('no bound image model supports the requested references/mask');
  }
  for (const { link, client } of capable) {
    assertNotAborted(signal);
    const built = buildRequest(prompt, negative, params, client.capabilities(), link);
    try {
      const result = await client.generate({ ...built.req, signal });
      if (!result.images.length) throw new Error('provider returned no images');
      return { link, result, keyColorFlow: built.keyColorFlow, keyColor: built.keyColor, size: built.req.size, quality: built.req.quality };
    } catch (err) {
      if (signal?.aborted) throw err; // cancellation is not a failover trigger
      errors.push(`${link.providerId}/${link.modelId}: ${(err as Error).message}`);
    }
  }
  throw new Error(`All image providers failed: ${errors.join(' | ')}`);
}

export async function runGenerationJob(
  deps: SpriteJobDeps,
  jobRow: SpriteGenerationJobRow,
  params: SpriteGenerationJobParams,
  signal?: AbortSignal,
): Promise<void> {
  const { jobs } = deps.stores;
  const jobId = jobRow.id;
  const setStatus = (status: SpriteJobStatus, pct?: number, note?: string): void => {
    jobs.updateStatus(jobId, status);
    deps.emit({ type: 'sprite_job', jobId, status, pct, note });
  };

  try {
    // ── prompting ──────────────────────────────────────────────────────
    assertNotAborted(signal);
    setStatus('prompting');
    const hasRefs = (params.referenceImages?.length ?? 0) > 0;
    let prompt = params.rawPrompt
      ? params.intent.trim()
      : buildFinalPrompt(params.intent, params.style, { hasReferences: hasRefs });
    // With references the LLM expander is SKIPPED: it cannot see the images
    // and rewords the intent into scene prose that pulls the model away from
    // them — the deterministic slim template is the faithful path.
    if (!params.rawPrompt && !hasRefs && deps.expandPrompt) {
      try {
        prompt = await deps.expandPrompt({
          intent: params.intent,
          style: params.style,
          assetName: params.assetName,
        });
      } catch {
        /* expander is best-effort — deterministic template already in place */
      }
    }
    jobs.setResult(jobId, { expanded_prompt: prompt });
    const negative = buildNegative(params.style);

    // ── generating ─────────────────────────────────────────────────────
    assertNotAborted(signal);
    setStatus('generating');
    // Frame-pack (default for n>1): ONE grid image sliced locally — image
    // models bill per image, so n variants cost 1. Opt out via packVariants
    // for maximum diversity (independent samplings, n× the cost).
    const wantN = Math.max(1, params.n ?? 1);
    const packed = wantN > 1 && params.packVariants !== false && !!deps.sliceImage;
    // Explicit grid (animation frame-packs: n×1 row) wins over the square fold.
    const grid = params.grid ?? gridFor(wantN);
    const genPrompt = packed ? prompt + buildGridSuffix(grid.cols, grid.rows, wantN) : prompt;
    const genParams = packed ? { ...params, n: 1 } : params;
    const won = await generateWithFailover(deps, genParams, genPrompt, negative, signal);
    jobs.setResult(jobId, {
      provider_id: won.link.providerId,
      model_id: won.link.modelId,
      // Subscription-billed providers (ChatGPT OAuth) have no per-image cost.
      cost_usd: won.link.providerKind === 'chatgpt'
        ? 0
        : estimateCost(won.link.modelId, won.result.images.length, won.size, won.quality, won.result.usage),
    });

    // ── postprocess (stage candidates in scratch, outside the repo) ────
    assertNotAborted(signal);
    setStatus('postprocess');
    const rawImages: Buffer[] = [];
    for (const image of won.result.images) {
      rawImages.push(Buffer.from(stripDataUriPrefix(image.base64), 'base64'));
    }
    const scratch = deps.scratchDir(jobId);
    fs.mkdirSync(scratch, { recursive: true });
    if (packed) {
      // Keep the ORIGINAL combined sheet so it can be re-sliced with a custom
      // grid later (adopt/pick promotes it into the repo). Then cut the cells.
      fs.writeFileSync(path.join(scratch, 'sheet.png'), rawImages[0]);
      const cells = await deps.sliceImage!(rawImages[0], grid.cols, grid.rows);
      rawImages.length = 0;
      rawImages.push(...cells.slice(0, wantN));
    }
    const n = rawImages.length;
    const ops = buildPostOps(params.style, params, won.keyColorFlow, won.keyColor);
    const candidates: SpriteJobCandidateRef[] = [];
    for (let i = 0; i < n; i++) {
      assertNotAborted(signal);
      const raw = rawImages[i];
      const processed = await deps.processImage(raw, ops, (opIdx, note) => {
        const pct = Math.round(((i + (ops.length ? opIdx / ops.length : 1)) / n) * 100);
        deps.emit({ type: 'sprite_job', jobId, status: 'postprocess', pct, note });
      });
      const candidateId = `candidate-${i}`;
      fs.writeFileSync(path.join(scratch, candidateFileName(i)), processed);
      candidates.push({ candidateId, index: i });
      deps.emit({
        type: 'sprite_variant_ready',
        jobId,
        index: i,
        candidateId,
        thumbUrl: `/api/sprite-studio/jobs/${jobId}/candidates/${i}/thumb`,
      });
    }

    // ── done: autoSave promotes candidate 0; interactive stays staged ──
    if (params.autoSave) {
      if (!deps.projectRoot) throw new Error('autoSave requires deps.projectRoot');
      if (jobRow.asset_id == null) throw new Error('autoSave requires job.asset_id');
      const asset = deps.stores.assets.get(jobRow.asset_id);
      if (!asset) throw new Error(`autoSave: unknown asset ${jobRow.asset_id}`);
      setStatus('saving');
      const version = await promoteCandidate(
        { stores: deps.stores, scratchDir: deps.scratchDir, projectRoot: deps.projectRoot, now: deps.now },
        { jobId, candidateIndex: 0, asset: { id: asset.id, slug: asset.slug } },
      );
      jobs.updateStatus(jobId, 'done');
      deps.emit({ type: 'sprite_job_done', jobId, versionId: version.id });
    } else {
      jobs.updateStatus(jobId, 'done');
      deps.emit({ type: 'sprite_job_done', jobId, candidates });
    }
  } catch (err) {
    if (signal?.aborted || (err as Error).name === 'AbortError') {
      jobs.updateStatus(jobId, 'cancelled');
      deps.emit({ type: 'sprite_job', jobId, status: 'cancelled' });
      return;
    }
    const message = (err as Error).message || String(err);
    jobs.setError(jobId, message);
    deps.emit({ type: 'sprite_job_failed', jobId, error: message });
  }
}
