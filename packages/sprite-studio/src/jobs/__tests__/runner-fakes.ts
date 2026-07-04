/**
 * Shared fakes for job-runner tests: an in-memory stores trio, a canned
 * 1x1-PNG image client and a fully faked SpriteJobDeps. Kept out of the
 * .test.ts file for the 200-LOC ceiling.
 */
import path from 'node:path';
import type { ImageGenCapabilities, ImageGenClient } from '@mcp/provider-sdk/images.js';
import type { SpriteAssetsStore, SpriteVersionInsertInput } from '@mcp/store/sprite-studio/sprite-assets-store.js';
import type { SpriteJobsStore } from '@mcp/store/sprite-studio/sprite-jobs-store.js';
import type { SpriteAssetVersionRow, SpriteGenerationJobRow } from '@mcp/store/sprite-studio/types.js';
import { encodePng } from '../../processing/png.js';
import type { SpriteOp } from '../../processing/types.js';
import type { ImageChainLink, SpriteJobDeps, SpriteJobStores } from '../deps.js';
import type { SpriteJobEvent } from '../events.js';

export const RED_1PX = encodePng({ rgba: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1 });

export const FULL_CAPS: ImageGenCapabilities = {
  edit: true,
  mask: true,
  transparentBackground: true,
  seed: true,
  negativePrompt: true,
  maxReferenceImages: 5,
};

export function fakeClient(
  caps: Partial<ImageGenCapabilities> = {},
  generate?: ImageGenClient['generate'],
): ImageGenClient {
  return {
    capabilities: () => ({ ...FULL_CAPS, ...caps }),
    generate:
      generate ??
      (async (req) => ({
        images: Array.from({ length: req.n ?? 1 }, () => ({
          base64: RED_1PX.toString('base64'),
          mediaType: 'image/png',
        })),
      })),
  };
}

export interface FakeWorld {
  deps: SpriteJobDeps;
  jobRow: SpriteGenerationJobRow;
  events: SpriteJobEvent[];
  statuses: string[];
  errors: string[];
  results: Array<Record<string, unknown>>;
  insertedVersions: SpriteVersionInsertInput[];
  capturedOps: SpriteOp[][];
  currentVersionSets: Array<[number, number | null]>;
}

export interface WorldOptions {
  scratchRoot: string;
  chain: Array<{ link: ImageChainLink; client: ImageGenClient }>;
  projectRoot?: string;
  assetId?: number | null;
  assetSlug?: string;
}

export function makeWorld(opts: WorldOptions): FakeWorld {
  const events: SpriteJobEvent[] = [];
  const statuses: string[] = [];
  const errors: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  const insertedVersions: SpriteVersionInsertInput[] = [];
  const capturedOps: SpriteOp[][] = [];
  const currentVersionSets: Array<[number, number | null]> = [];

  const jobRow = {
    id: 900,
    sprite_project_id: 5,
    asset_id: opts.assetId ?? null,
    kind: 'generate',
    status: 'queued',
    user_intent: 'a goblin chef',
    expanded_prompt: null,
    request: null,
    provider_id: null,
    model_id: null,
    cost_usd: null,
    error: null,
    result_version_id: null,
    started_at: null,
    finished_at: null,
    created_at: '2026-07-03T00:00:00Z',
  } as SpriteGenerationJobRow;

  const jobs = {
    get: (id: number) => (id === jobRow.id ? jobRow : null),
    updateStatus: (_id: number, status: string) => {
      statuses.push(status);
      (jobRow as { status: string }).status = status;
      return true;
    },
    setResult: (_id: number, input: Record<string, unknown>) => {
      results.push(input);
      if (input.expanded_prompt !== undefined) jobRow.expanded_prompt = input.expanded_prompt as string;
      if (input.provider_id !== undefined) jobRow.provider_id = input.provider_id as string;
      if (input.model_id !== undefined) jobRow.model_id = input.model_id as string;
      if (input.result_version_id !== undefined) jobRow.result_version_id = input.result_version_id as number;
      return true;
    },
    setError: (_id: number, error: string) => {
      errors.push(error);
      (jobRow as { status: string }).status = 'failed';
      return true;
    },
  } as unknown as SpriteJobsStore;

  let nextVersionRowId = 101;
  const assets = {
    get: (id: number) =>
      id === opts.assetId ? { id, slug: opts.assetSlug ?? 'goblin', sprite_project_id: 5 } : null,
    insertVersion: (input: SpriteVersionInsertInput): SpriteAssetVersionRow => {
      insertedVersions.push(input);
      return { id: nextVersionRowId++, ...input, created_at: 'now' } as unknown as SpriteAssetVersionRow;
    },
    setCurrentVersion: (assetId: number, versionId: number | null) => {
      currentVersionSets.push([assetId, versionId]);
      return true;
    },
  } as unknown as SpriteAssetsStore;

  const stores: SpriteJobStores = { projects: {} as SpriteJobStores['projects'], assets, jobs };

  const deps: SpriteJobDeps = {
    stores,
    resolveImageChain: async () => opts.chain.map((c) => c.link),
    createImageClient: async (providerId, modelId) => {
      const found = opts.chain.find(
        (c) => c.link.providerId === providerId && c.link.modelId === modelId,
      );
      if (!found) throw new Error(`no fake client for ${providerId}/${modelId}`);
      return found.client;
    },
    processImage: async (png, ops, onProgress) => {
      capturedOps.push(ops);
      onProgress?.(0, 'fake-op');
      return png; // identity
    },
    scratchDir: (jobId) => path.join(opts.scratchRoot, String(jobId)),
    projectRoot: opts.projectRoot ? () => opts.projectRoot as string : undefined,
    emit: (ev) => events.push(ev),
    now: () => '2026-07-03T00:00:00.000Z',
  };

  return { deps, jobRow, events, statuses, errors, results, insertedVersions, capturedOps, currentVersionSets };
}
