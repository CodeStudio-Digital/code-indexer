/**
 * QualityClassifierPipeline — runs all configured classifiers in parallel
 * (the `PlanMaster.exec` pattern from grox/plans/plan_master.py:18-29):
 *
 *   results = await Promise.all(classifiers.map(c => c.classify(output)))
 *
 * After completion, optionally writes one row per classifier to
 * `quality_classifications` and emits a single `TelemetryEvent` per call.
 *
 * Each classifier is independent — a single failing classifier doesn't
 * stop the others (the LLMClassifier base wraps errors as
 * `{ verdict: 'error', reason: ... }` so the pipeline gets a row instead
 * of an exception).
 */
import type { TelemetryEvent, TelemetrySink } from '@mcp/candidate-pipeline/stats.js';
import {
  durationToBucket,
  sizeToBucket,
} from '@mcp/candidate-pipeline/stats.js';
import { mapWithConcurrency } from '@mcp/shared';
import type {
  QualityClassificationStore,
  QualityClassificationInsert,
} from '@mcp/store/quality-classification-store.js';
import type { LLMClassifier } from './llm-classifier.js';
import type {
  AgentOutputForClassification,
  ClassificationVerdict,
  QualityResult,
  QualityVerdict,
} from './types.js';

export interface QualityClassifierPipelineOptions {
  /** All classifiers that should run. Order doesn't matter — they're parallel. */
  classifiers: LLMClassifier[];
  /** Optional persistent store for verdicts. */
  store?: QualityClassificationStore;
  /** Optional telemetry sink. */
  telemetry?: TelemetrySink;
  /**
   * Max classifiers calling the provider at once. The 5 classifiers share
   * one provider quota, so firing all 5 simultaneously every turn is what
   * trips the rate-limit. Default 2 — enough parallelism to stay fast,
   * low enough to avoid self-inflicted 429 bursts.
   */
  maxConcurrency?: number;
}

const DEFAULT_CLASSIFIER_CONCURRENCY = 2;

const VERDICT_ORDER: Record<QualityVerdict, number> = {
  ok: 0,
  warn: 1,
  error: 2,
  flagged: 3,
};

function worstOf(verdicts: ClassificationVerdict[]): QualityVerdict {
  return verdicts.reduce<QualityVerdict>((worst, v) => {
    return VERDICT_ORDER[v.verdict] > VERDICT_ORDER[worst] ? v.verdict : worst;
  }, 'ok');
}

export class QualityClassifierPipeline {
  constructor(private opts: QualityClassifierPipelineOptions) {}

  /** Run all classifiers in parallel. Never throws. */
  async classify(output: AgentOutputForClassification): Promise<QualityResult> {
    const started = performance.now();
    const settled = await mapWithConcurrency(
      this.opts.classifiers,
      this.opts.maxConcurrency ?? DEFAULT_CLASSIFIER_CONCURRENCY,
      (c) =>
        c.classify(output).catch((err: unknown): ClassificationVerdict => ({
          classifierName: c.classifierName,
          verdict: 'error',
          systemError: true,
          reason: (err as Error)?.message?.slice(0, 500) ?? 'unknown classifier error',
          latencyMs: 0,
        })),
    );

    const verdicts: ClassificationVerdict[] = settled.map((r, i): ClassificationVerdict => {
      if (r.status === 'fulfilled') return r.value;
      const c = this.opts.classifiers[i];
      return {
        classifierName: c.classifierName,
        verdict: 'error',
        systemError: true,
        reason: `pipeline rejection: ${(r.reason as Error)?.message ?? 'unknown'}`,
        latencyMs: 0,
      };
    });

    // Optional persistence — one row per classifier verdict.
    if (this.opts.store) {
      for (const v of verdicts) {
        const row: QualityClassificationInsert = {
          session_id: output.sessionId ?? null,
          company_session_id: output.companySessionId ?? null,
          agent_run_id: output.agentRunId ?? null,
          message_id: output.messageId ?? null,
          classifier_name: v.classifierName,
          verdict: v.verdict,
          // Mig 202 — persiste a separação infra-vs-conteúdo que a telemetria
          // já fazia em memória; sem isso todo leitor do DB via 'error' misto.
          system_error: v.systemError === true,
          confidence: v.confidence ?? null,
          reason: v.reason ?? null,
          provider_id: v.providerId ?? null,
          model_id: v.modelId ?? null,
          latency_ms: v.latencyMs,
          raw_response: v.raw,
        };
        try { this.opts.store.insert(row); } catch { /* never throw from persistence */ }
      }
    }

    const durationMs = performance.now() - started;
    // Aggregated telemetry event.
    if (this.opts.telemetry) {
      // Only classifier FAILURES count as telemetry errors. A content verdict
      // of 'error' (the LLM judging the agent output as broken) is the
      // classifier working correctly — counting it would make every run look
      // broken. Content errors/flagged go to diag for visibility.
      const systemErrors = verdicts.filter((v) => v.systemError).length;
      const contentErrors = verdicts.filter((v) => v.verdict === 'error' && !v.systemError).length;
      const flagged = verdicts.filter((v) => v.verdict === 'flagged').length;
      const event: TelemetryEvent = {
        pipelineName: 'quality_classifiers',
        stage: 'side_effect',
        component: 'classify',
        durationMs,
        durationBucket: durationToBucket(durationMs),
        candidatesIn: verdicts.length,
        candidatesOut: verdicts.length - systemErrors,
        sizeBucket: sizeToBucket(verdicts.length),
        errors: systemErrors,
        sessionId: output.sessionId ?? undefined,
        companySessionId: output.companySessionId ?? undefined,
        diag: { flagged, contentErrors },
      };
      try { this.opts.telemetry.emit(event); } catch { /* never throw */ }
    }

    return { verdicts, worstVerdict: worstOf(verdicts), durationMs };
  }
}
