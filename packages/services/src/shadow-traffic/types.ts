/**
 * Types for the shadow-traffic / counterfactual-logging infrastructure.
 *
 * Translated from `home-mixer/side_effects/phoenix_experiments_side_effect.rs:40-62`
 * (xai-org/x-algorithm). The pattern:
 *
 *   1. The PRODUCTION pipeline runs and serves its result to the user.
 *   2. The SAME query, after the response is sent, is replayed on N
 *      "shadow variants" of the pipeline (different params, different
 *      provider, different scorer mix, etc.).
 *   3. Each variant's prediction is logged to `counterfactual_logs`
 *      alongside what production chose.
 *   4. Later, a feedback collector observes the true outcome (user
 *      accepted, master spawned, etc.) and backfills `true_outcome_json`.
 *
 * Shadow variants run OFF the response path — failures are swallowed and
 * never affect production. Sample rate caps total spend.
 */

export interface ShadowQuery {
  /** Stable per-request hash so variants share a key. */
  queryHash: string;
  /** Optional UUIDs route the observation to a filesystem session sink. */
  sessionId?: string | null;
  companySessionId?: string | null;
  /** Free-form payload — the pipeline-specific query object. */
  payload: unknown;
}

export interface ShadowVariantResult {
  variantName: string;
  /** Pipeline-specific output snapshot (must be JSON-serializable). */
  prediction: unknown;
  durationMs: number;
  error?: string;
}

/**
 * A shadow variant — runs a single alternative configuration of the
 * pipeline against the same query and returns its prediction (or an
 * error). Implementors decide what the variant means (alternative k,
 * alternative weights, alternative provider, …).
 */
export interface ShadowVariant<Q> {
  /** Stable identifier persisted to counterfactual_logs.shadow_variant. */
  readonly name: string;
  /** Decide whether to run this variant for a specific request. */
  enable(query: Q): boolean;
  /** Run the variant; return its prediction in a JSON-serializable shape. */
  run(query: Q): Promise<unknown>;
}

export interface ShadowEnvelope {
  pipelineName: string;
  productionChoice: unknown;
  shadowQuery: ShadowQuery;
}

export interface ShadowTrafficStats {
  enabled: boolean;
  sampleRate: number;
  variantsCount: number;
  runsTotal: number;
  runsLastFlush: number;
  errorsLastFlush: number;
}
