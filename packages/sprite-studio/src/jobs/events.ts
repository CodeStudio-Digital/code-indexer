/**
 * Sprite job events — the wire contract between the job runner and the SSE
 * layer (plan PARTE 2 §2.6 item 2). The http-api glue forwards each event
 * verbatim onto the per-sprite-project bus; `type` doubles as the SSE event
 * name. The dashboard mirrors these payloads in
 * `apps/dashboard/features/sprite-studio/jobs/job-types.ts`.
 */

/** Status/progress tick while a job walks its lifecycle. */
export interface SpriteJobStatusEvent {
  type: 'sprite_job';
  jobId: number;
  /** SpriteJobStatus value (queued|prompting|generating|postprocess|saving|...). */
  status: string;
  /** Coarse progress 0..100 when computable. */
  pct?: number;
  /** Human-readable note ("quantize to 16 colors", provider being tried, ...). */
  note?: string;
}

/**
 * One staged candidate finished post-processing. Candidates live in the job
 * scratch dir OUTSIDE the repo — no version row exists until the user picks
 * one (staged-variants flow, §2.6 item 3).
 */
export interface SpriteVariantReadyEvent {
  type: 'sprite_variant_ready';
  jobId: number;
  index: number;
  /** Stable id, `candidate-<index>` (also the scratch file basename). */
  candidateId: string;
  thumbUrl: string;
}

/** Reference to a staged candidate carried by the terminal done event. */
export interface SpriteJobCandidateRef {
  candidateId: string;
  index: number;
}

/**
 * Terminal success. Auto-saved jobs (agent path) carry `versionId`;
 * interactive jobs carry `candidates` and create NO version rows.
 */
export interface SpriteJobDoneEvent {
  type: 'sprite_job_done';
  jobId: number;
  versionId?: number;
  candidates?: SpriteJobCandidateRef[];
}

/** Terminal failure (every link failed, processing threw, ...). */
export interface SpriteJobFailedEvent {
  type: 'sprite_job_failed';
  jobId: number;
  error: string;
}

export type SpriteJobEvent =
  | SpriteJobStatusEvent
  | SpriteVariantReadyEvent
  | SpriteJobDoneEvent
  | SpriteJobFailedEvent;

export type SpriteJobEmitter = (ev: SpriteJobEvent) => void;
