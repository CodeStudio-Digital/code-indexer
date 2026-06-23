/**
 * ShadowTrafficRunner — the orchestration layer for one pipeline's shadow
 * variants.
 *
 * Usage:
 *
 *   const runner = new ShadowTrafficRunner({
 *     pipelineName: 'tool_selection',
 *     variants: [
 *       new TopKVariant('k_8', 8),
 *       new TopKVariant('k_16', 16),
 *     ],
 *     store: counterfactualLogStore,
 *     sampleRate: 0.05,
 *   });
 *
 *   // ... production pipeline runs and produces `productionChoice` ...
 *   runner.recordAndShadow({ payload: productionQuery, queryHash, sessionId }, productionChoice);
 *   //   ↑ returns immediately. Variant runs fire-and-forget via setImmediate.
 *
 * Sampling is deterministic-per-hash so the same query consistently goes
 * to shadow (or doesn't). This makes counterfactual rows comparable to
 * production rows — biased sampling would skew the analytics.
 */
import type { TelemetryEvent, TelemetrySink } from '@mcp/candidate-pipeline/stats.js';
import {
  durationToBucket,
} from '@mcp/candidate-pipeline/stats.js';
import type {
  CounterfactualLogInsert,
  CounterfactualLogStore,
} from '@mcp/store/counterfactual-log-store.js';
import type {
  ShadowQuery,
  ShadowTrafficStats,
  ShadowVariant,
  ShadowVariantResult,
} from './types.js';

export interface ShadowTrafficRunnerConfig<Q> {
  /** Pipeline name (must match the PIPELINE_CATALOG entry). */
  pipelineName: string;
  /** Shadow variants. Each runs once per sampled request. */
  variants: ShadowVariant<Q>[];
  /** Persistent log table. */
  store: CounterfactualLogStore;
  /** Probability of sampling a given query into shadow. 0..1. */
  sampleRate?: number;
  /** Optional telemetry sink. */
  telemetry?: TelemetrySink;
  /** Optional override of Date.now() for tests. */
  now?: () => number;
  /** Optional override for setImmediate scheduling (tests pass `await x`). */
  scheduler?: (fn: () => void) => void;
}

export class ShadowTrafficRunner<Q> {
  private runsTotal = 0;
  private runsLastFlush = 0;
  private errorsLastFlush = 0;
  private readonly cfg: Required<ShadowTrafficRunnerConfig<Q>>;

  constructor(cfg: ShadowTrafficRunnerConfig<Q>) {
    this.cfg = {
      pipelineName: cfg.pipelineName,
      variants: cfg.variants,
      store: cfg.store,
      sampleRate: clampRate(cfg.sampleRate ?? 0.05),
      telemetry: cfg.telemetry ?? { emit: () => {} },
      now: cfg.now ?? Date.now,
      scheduler: cfg.scheduler ?? ((fn) => { setImmediate(fn); }),
    };
  }

  get enabled(): boolean { return this.cfg.sampleRate > 0 && this.cfg.variants.length > 0; }

  stats(): ShadowTrafficStats {
    return {
      enabled: this.enabled,
      sampleRate: this.cfg.sampleRate,
      variantsCount: this.cfg.variants.length,
      runsTotal: this.runsTotal,
      runsLastFlush: this.runsLastFlush,
      errorsLastFlush: this.errorsLastFlush,
    };
  }

  /**
   * Sample the query and, if selected, schedule the shadow variants to
   * run off the response path. Returns synchronously regardless.
   */
  recordAndShadow(shadowQuery: ShadowQuery, productionChoice: unknown): boolean {
    if (!this.enabled) return false;
    if (!this.shouldSample(shadowQuery.queryHash)) return false;
    this.cfg.scheduler(() => {
      void this.runVariants(shadowQuery, productionChoice);
    });
    return true;
  }

  /**
   * Synchronously run variants and write rows. Exposed for tests that
   * need to await the side effect.
   */
  async runVariants(shadowQuery: ShadowQuery, productionChoice: unknown): Promise<ShadowVariantResult[]> {
    const enabledVariants = this.cfg.variants.filter((v) => {
      try { return v.enable(shadowQuery.payload as Q); } catch { return false; }
    });
    const results: ShadowVariantResult[] = await Promise.all(
      enabledVariants.map(async (variant): Promise<ShadowVariantResult> => {
        const t0 = performance.now();
        try {
          const prediction = await variant.run(shadowQuery.payload as Q);
          const durationMs = performance.now() - t0;
          return { variantName: variant.name, prediction, durationMs };
        } catch (e) {
          const durationMs = performance.now() - t0;
          return {
            variantName: variant.name,
            prediction: null,
            durationMs,
            error: (e as Error).message?.slice(0, 500) ?? 'unknown error',
          };
        }
      }),
    );

    this.runsTotal += results.length;
    this.runsLastFlush += results.length;

    for (const result of results) {
      const row: CounterfactualLogInsert = {
        session_id: shadowQuery.sessionId ?? null,
        company_session_id: shadowQuery.companySessionId ?? null,
        pipeline_name: this.cfg.pipelineName,
        shadow_variant: result.variantName,
        query_hash: shadowQuery.queryHash,
        production_choice: productionChoice,
        shadow_prediction: result.prediction,
      };
      try { this.cfg.store.insert(row); } catch { /* never throw from shadow */ }
      if (result.error) this.errorsLastFlush++;

      // Telemetry per variant: emits a side_effect event tagged with the
      // variant name, so admins can spot a misbehaving variant quickly.
      const event: TelemetryEvent = {
        pipelineName: this.cfg.pipelineName,
        stage: 'side_effect',
        component: `shadow/${result.variantName}`,
        durationMs: result.durationMs,
        durationBucket: durationToBucket(result.durationMs),
        errors: result.error ? 1 : 0,
      };
      try { this.cfg.telemetry.emit(event); } catch { /* never throw */ }
    }
    return results;
  }

  /**
   * Reset the per-flush counters. The admin endpoint reads `stats()`
   * before and after to compute deltas; tests call it directly.
   */
  flushCounters(): void {
    this.runsLastFlush = 0;
    this.errorsLastFlush = 0;
  }

  /**
   * Deterministic-per-hash sampling. Same queryHash always sampled or
   * always skipped — making counterfactual analytics non-biased.
   */
  private shouldSample(queryHash: string): boolean {
    if (this.cfg.sampleRate >= 1) return true;
    if (this.cfg.sampleRate <= 0) return false;
    // FNV-1a hash → [0, 1) → compare against sampleRate.
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < queryHash.length; i++) {
      h ^= queryHash.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const score = (h >>> 0) / 0xffffffff;
    return score < this.cfg.sampleRate;
  }
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
}
