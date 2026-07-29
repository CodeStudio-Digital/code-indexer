/**
 * Sprite Studio — job params + SSE event payloads (plan PARTE 2 §2.6).
 * These shapes ARE the wire contract: the backend job runner emits exactly
 * these event names/payloads on the per-project bus, and the generate route
 * accepts the discriminated `SpriteJobParams` union as its body.
 */
import type { SpriteCategory } from '../types.js';

// ─── Job params (POST body, discriminated on `kind`) ────────────────────
export interface SpriteProcessOp {
  /** Deterministic op name (quantize, bg-remove, outline, resize-nn, …). */
  name: string;
  params: Record<string, unknown>;
}

export interface GenerationJobParams {
  kind: 'generation';
  /** Target asset — omitted for "generate into a new asset" flows. */
  assetId?: string;
  prompt: string;
  /** Variant count; n>1 stages candidates (no version rows until picked). */
  n: number;
  /** Version ids attached as identity/style references (validated server-side). */
  referenceIds?: string[];
  /** Attach the asset's CURRENT version as the identity reference. */
  useCurrentAsRef?: boolean;
  /** Disk-upload references (client downscales to ≤768px before sending). */
  uploadRefs?: Array<{ base64: string; mediaType: string }>;
  /** Skip the prompt_expander stage and send the prompt as-is. */
  rawPrompt?: boolean;
  seed?: number | null;
  size?: { width: number; height: number };
}

export interface InpaintJobParams {
  kind: 'inpaint';
  assetId: string;
  versionId: string;
  prompt: string;
  /** Raw PNG mask bytes as base64 (white = repaint region). */
  maskBase64: string;
  rawPrompt?: boolean;
  seed?: number | null;
  n: number;
}

export interface EnhanceJobParams {
  kind: 'enhance';
  assetId: string;
  versionId: string;
  prompt: string;
  rawPrompt?: boolean;
  seed?: number | null;
  n: number;
}

export interface ProcessJobParams {
  kind: 'process';
  assetId: string;
  versionId: string;
  ops: SpriteProcessOp[];
}

export interface ExportJobParams {
  kind: 'export';
  scope: 'asset' | 'category' | 'approved';
  assetId?: string;
  category?: SpriteCategory;
  exportProfileId?: number;
}

export type SpriteJobParams =
  | GenerationJobParams
  | InpaintJobParams
  | EnhanceJobParams
  | ProcessJobParams
  | ExportJobParams;

// ─── SSE payloads (unified event names, plan §2.6 item 2) ───────────────
export type SpriteJobStatus =
  | 'queued' | 'prompting' | 'generating' | 'post-processing'
  | 'checking' | 'saving' | 'done' | 'failed' | 'cancelled';

/** Event `sprite_job` — status/progress ticks while a job runs. */
export interface SpriteJobEvent {
  jobId: string;
  status: SpriteJobStatus;
  pct?: number;
  note?: string;
}

/** Event `sprite_variant_ready` — one staged candidate finished (scratch,
 *  NOT a version row; picking it later creates the version). */
export interface SpriteVariantReadyEvent {
  jobId: string;
  index: number;
  candidateId: string;
  thumbUrl: string;
}

export interface SpriteJobCandidate {
  index: number;
  candidateId: string;
  thumbUrl: string;
}

/** Event `sprite_job_done` — auto-saved jobs carry `versionId`; interactive
 *  n>1 jobs carry `candidates` instead (staged flow). */
export interface SpriteJobDoneEvent {
  jobId: string;
  versionId?: string;
  candidates?: SpriteJobCandidate[];
}

/** Event `sprite_job_failed`. */
export interface SpriteJobFailedEvent {
  jobId: string;
  error: string;
}
