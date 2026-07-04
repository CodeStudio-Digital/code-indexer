/**
 * Dependency-injection seam for the sprite job layer.
 *
 * The runner never constructs providers, stores or workers itself — the
 * http-api glue wires the real things (PipelineProviderResolver,
 * createImagesProvider, SpriteWorkerClient, mcp data dir) into this
 * interface. Everything here is a TYPE-ONLY import, so the package stays
 * unit-testable and worker-friendly (no @mcp/services at runtime).
 */
import type { ImageGenClient } from '@mcp/provider-sdk/images.js';
import type { SpriteAssetsStore } from '@mcp/store/sprite-studio/sprite-assets-store.js';
import type { SpriteJobsStore } from '@mcp/store/sprite-studio/sprite-jobs-store.js';
import type { SpriteProjectsStore } from '@mcp/store/sprite-studio/sprite-projects-store.js';
import type { SpriteStyleConfig } from '@mcp/store/sprite-studio/types.js';
import type { SpriteOp } from '../processing/types.js';
import type { SpriteJobEmitter } from './events.js';

/** One link of the `sprite-studio/image_gen` binding chain, in failover order. */
export interface ImageChainLink {
  providerId: string;
  modelId: string;
  /** Provider shape (e.g. 'chatgpt' = subscription-billed → cost 0 in the ledger). */
  providerKind?: string;
  /** Binding config JSON — default request params ({ size, quality, n }). */
  config?: Record<string, unknown>;
}

export interface SpriteJobStores {
  projects: SpriteProjectsStore;
  assets: SpriteAssetsStore;
  jobs: SpriteJobsStore;
}

export interface SpriteJobDeps {
  stores: SpriteJobStores;

  /** Glue wraps `PipelineProviderResolver.resolveChain('sprite-studio','image_gen')`. */
  resolveImageChain(): Promise<ImageChainLink[]>;

  /** Glue wraps `createImagesProvider(providerId, modelId)` (@mcp/services). */
  createImageClient(providerId: string, modelId: string): Promise<ImageGenClient>;

  /**
   * Optional LLM prompt expander (`sprite-studio/prompt_expander` binding).
   * Absent or throwing → the deterministic template (prompt-template.ts).
   */
  expandPrompt?(input: {
    intent: string;
    style: SpriteStyleConfig;
    assetName?: string;
  }): Promise<string>;

  /** Glue routes to the sprite worker (`process.pipeline` RPC). */
  processImage(
    png: Buffer,
    ops: SpriteOp[],
    onProgress?: (i: number, note: string) => void,
  ): Promise<Buffer>;

  /**
   * Slice one packed grid image into cols×rows cell PNGs (frame-pack mode:
   * n variants from ONE generation — ~n× cheaper). Optional — absent → the
   * runner falls back to n independent generations.
   */
  sliceImage?(png: Buffer, cols: number, rows: number): Promise<Buffer[]>;

  /** Per-job scratch dir OUTSIDE the repo (glue: `mcpDataDir()/sprite-studio/tmp/<jobId>`). */
  scratchDir(jobId: number): string;

  /**
   * Absolute repo root of the game project owning a sprite project.
   * Required only for the autoSave path (agent-triggered jobs that write a
   * version straight into `.sprite-studio/`); interactive jobs never call it.
   */
  projectRoot?(spriteProjectId: number): Promise<string> | string;

  emit: SpriteJobEmitter;

  /** ISO timestamp override for tests; defaults to `new Date().toISOString()`. */
  now?(): string;
}
