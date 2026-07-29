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
import type {
  SpriteJobKind,
  SpriteJobStatus,
  SpriteStyleConfig,
  SpriteVersionSource,
} from '@mcp/store/sprite-studio/types.js';
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

export interface SpriteJobAssetRecord {
  id: string;
  slug: string;
  current_version_id: string | null;
}

export interface SpriteJobVersionRecord {
  id: string;
  asset_id: string;
  version: number;
  file_rel_path: string;
  source: SpriteVersionSource;
}

export interface SpriteJobRecord {
  id: string;
  sprite_project_id: string;
  asset_id: string | null;
  kind: SpriteJobKind;
  status: SpriteJobStatus;
  user_intent: string | null;
  expanded_prompt: string | null;
  request: Record<string, unknown> | null;
  result_version_id: string | null;
}

export interface SpriteJobStores {
  assets: {
    get(id: string): Promise<SpriteJobAssetRecord | null>;
    insertVersion(input: {
      asset_id: string;
      version?: number;
      file_rel_path: string;
      width?: number | null;
      height?: number | null;
      source: SpriteVersionSource;
      prompt?: string | null;
      user_intent?: string | null;
      gen_params?: Record<string, unknown> | null;
      parent_version_id?: string | null;
      job_id?: string | null;
      content_hash?: string | null;
    }): Promise<SpriteJobVersionRecord>;
    setCurrentVersion(assetId: string, versionId: string | null): Promise<boolean>;
  };
  jobs: {
    get(id: string): Promise<SpriteJobRecord | null>;
    updateStatus(id: string, status: SpriteJobStatus): Promise<unknown>;
    setResult(id: string, patch: Record<string, unknown>): Promise<unknown>;
    setError(id: string, error: string): Promise<unknown>;
  };
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
  scratchDir(jobId: string): string;

  /**
   * Absolute repo root of the game project owning a sprite project.
   * Required only for the autoSave path (agent-triggered jobs that write a
   * version straight into `.sprite-studio/`); interactive jobs never call it.
   */
  projectRoot?(spriteProjectId: string): Promise<string> | string;

  emit: SpriteJobEmitter;

  /** ISO timestamp override for tests; defaults to `new Date().toISOString()`. */
  now?(): string;
}
