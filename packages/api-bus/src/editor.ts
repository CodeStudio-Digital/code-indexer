import type { ApiContext } from './common.js';

/**
 * Editor AI services — inline autocomplete (ghost text).
 *
 * Backed by the `editor/autocomplete` pipeline binding (admin-configured).
 * No binding → every call answers `{ status: 'unconfigured' }` cheaply and
 * the client snoozes; nothing is ever sent to a provider without a binding.
 * Source: packages/api-handlers/src/editor/.
 */

export type EditorCompleteStatus =
  | 'ok'
  | 'empty'
  | 'unconfigured'
  | 'timeout'
  | 'provider_error';

export interface EditorCompleteInput {
  projectId: number;
  /** Project-relative path (same key as LSP/doc-sync). */
  file: string;
  /** Monaco language id (e.g. 'typescript', 'php'). */
  language: string;
  /** 1-based line / 1-based column of the cursor. */
  position: { line: number; col: number };
  /** Text before the cursor (client pre-trims to a window). */
  prefix: string;
  /** Text after the cursor (client pre-trims to a window). */
  suffix: string;
}

export interface EditorCompleteResult {
  status: EditorCompleteStatus;
  /** Present when status==='ok' — raw code to ghost-insert at the cursor. */
  text?: string;
  /** Server-suggested debounce (binding config + adaptive) — client adopts it. */
  debounceMs?: number;
  /** Correlates accept feedback with the completion request. */
  requestId?: string;
  /** Short diagnostic for provider_error (never the raw provider body). */
  message?: string;
  /** Suggested snooze on provider errors (rate-limit aware). */
  retryAfterMs?: number;
  /** Client prefilter strictness (derived from the binding's aggressiveness). */
  suppression?: 'strict' | 'standard' | 'lenient';
  /** What produced the text — diagnostics/status-chip only. */
  served?: 'model' | 'cache' | 'forward';
}

/**
 * Completion lifecycle signals. 'shown'/'accept'/'partial'/'reject' correlate
 * to a requestId; 'prefilter_skip' is a throttled client-side counter batch.
 */
export type EditorFeedbackAction = 'shown' | 'accept' | 'partial' | 'reject' | 'prefilter_skip';

export interface EditorFeedbackInput {
  projectId: number;
  /** Required for lifecycle actions; absent for prefilter_skip batches. */
  requestId?: string;
  action: EditorFeedbackAction;
  /** partial: cumulative accepted characters (Monaco reports cumulative). */
  acceptedChars?: number;
  /** reject: how long the ghost text was visible before dismissal. */
  shownForMs?: number;
  /** partial: which accept gesture (Monaco PartialAcceptTriggerKind). */
  partialKind?: 'word' | 'line' | 'suggest';
  /** prefilter_skip: accumulated per-rule counts, e.g. "r1:12,r3:4". */
  detail?: string;
}

/** Aggregated completion quality metrics (chip tooltip + admin panel). */
export interface EditorStatsResult {
  configured: boolean;
  model: string | null;
  windowDays: number;
  requests: number;
  shown: number;
  accepted: number;
  partial: number;
  rejected: number;
  /** accepted/shown; null while no shown events exist (pre-rollout data). */
  acceptRate: number | null;
  latency: { p50: number | null; p90: number | null };
  statusBreakdown: Record<string, number>;
  endpointSplit: Record<string, number>;
  byModel: Array<{ model: string; requests: number; shown: number; accepted: number }>;
  daily: Array<{ day: string; requests: number; shown: number; accepted: number }>;
}

export interface EditorApi {
  /**
   * One inline-completion request. Single-flight per (projectId,file) on
   * the server — a newer call aborts the in-flight provider request.
   */
  complete(input: EditorCompleteInput, ctx: ApiContext): Promise<EditorCompleteResult>;

  /** Fire-and-forget lifecycle signal (telemetry: real accept/reject rates). */
  feedback(input: EditorFeedbackInput, ctx: ApiContext): Promise<{ ok: boolean }>;

  /** Completion quality stats over the last `days` (≤30, telemetry prune). */
  stats(input: { days?: number }, ctx: ApiContext): Promise<EditorStatsResult>;
}
