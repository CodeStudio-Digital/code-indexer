import type { ApiContext } from './common.js';

/** Wire-compatible with the richer @mcp/shared EditorSettingsOverride type. */
export type EditorSettingsOverride = { version?: 1 } & Record<string, unknown>;

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
  | 'manual_only'
  | 'timeout'
  | 'provider_error';

export type EditorCompletionSuitability =
  | 'native-fim'
  | 'template-fim'
  | 'verified-fast-chat'
  | 'best-effort-chat';

export type EditorCompletionHealth =
  | 'healthy'
  | 'unknown'
  | 'degraded'
  | 'circuit-open'
  | 'rate-limited'
  | 'auth-blocked';

export interface EditorCompletionRoute {
  bindingId: number | null;
  providerId: string;
  provider: string;
  model: string;
  transport: 'native-fim' | 'template-fim' | 'chat' | 'oauth-chat';
  suitability: EditorCompletionSuitability;
  health: EditorCompletionHealth;
  /** Safe, user-facing explanation; never includes credentials/provider bodies. */
  reason?: string;
}

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
  /** Automatic ghost text obeys suitability gates; explicit is Alt+\\. */
  trigger?: 'automatic' | 'explicit';
  /** Stable client-generated id used for exact cancellation/latest-wins. */
  clientRequestId?: string;
  /** Monaco model version at the time the request was assembled. */
  documentVersion?: number;
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
  /** Effective route, including failover/circuit suitability metadata. */
  route?: EditorCompletionRoute;
}

export interface EditorCancelInput {
  projectId: number;
  clientRequestId: string;
}

export interface EditorProbeInput {
  /** Omit all fields to probe the currently effective binding. */
  bindingId?: number;
  /** Probe a provider/model before creating a binding (setup flow). */
  providerId?: string;
  modelId?: string;
}

export interface EditorProbeResult {
  ok: boolean;
  route?: EditorCompletionRoute;
  samples: Array<{ language: string; latencyMs: number; ttftMs: number | null; status: string }>;
  latency: { p50: number | null; p90: number | null };
  /** True when all three synthetic prompts passed the automatic-completion SLO. */
  verifiedForAutomatic: boolean;
  message?: string;
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

export type EditorDeliveryStage = 'received' | 'returned' | 'discarded';
export type EditorDeliveryDiscardReason =
  | 'cancelled'
  | 'version_changed'
  | 'prefix_diverged'
  | 'empty_after_trim';

/** Technical browser-to-Monaco delivery funnel; never contains source code. */
export interface EditorDeliveryInput {
  projectId: number;
  clientRequestId: string;
  requestId?: string;
  stage: EditorDeliveryStage;
  reason?: EditorDeliveryDiscardReason;
  documentVersion?: number;
}

export interface EditorDeliveryStats {
  received: number;
  returned: number;
  discarded: number;
  discardReasons: Record<string, number>;
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
  delivery: EditorDeliveryStats;
  /** Metrics restricted to the currently resolved binding/model. */
  current: {
    bindingId: number | null;
    requests: number;
    shown: number;
    accepted: number;
    rejected: number;
    acceptRate: number | null;
    latency: { p50: number | null; p90: number | null };
    statusBreakdown: Record<string, number>;
    delivery: EditorDeliveryStats;
  };
  route?: EditorCompletionRoute;
}

export interface EditorApi {
  /** Resolve repository .editorconfig values for one project-relative file. */
  resolveConfig(
    input: { projectId: number; file: string },
    ctx: ApiContext,
  ): Promise<{ settings: EditorSettingsOverride; sources: string[] }>;
  /**
   * One inline-completion request. Latest-wins per (projectId,file): compatible
   * prefix advances coalesce; incompatible edits abort the older request.
   */
  complete(input: EditorCompleteInput, ctx: ApiContext): Promise<EditorCompleteResult>;

  /** Abort one exact client request; stale results remain ignored server-side. */
  cancel(input: EditorCancelInput, ctx: ApiContext): Promise<{ ok: boolean }>;

  /** Three synthetic, project-free completion calls against one binding. */
  probe(input: EditorProbeInput, ctx: ApiContext): Promise<EditorProbeResult>;

  /** Fire-and-forget lifecycle signal (telemetry: real accept/reject rates). */
  feedback(input: EditorFeedbackInput, ctx: ApiContext): Promise<{ ok: boolean }>;

  /** Technical delivery stage between a healthy response and Monaco render. */
  delivery(input: EditorDeliveryInput, ctx: ApiContext): Promise<{ ok: boolean }>;

  /** Completion quality stats over the last `days` (≤30, telemetry prune). */
  stats(input: { days?: number }, ctx: ApiContext): Promise<EditorStatsResult>;
}
