/**
 * QualityClassifierPipeline — runs all configured evaluators with bounded concurrency
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
import { randomUUID } from 'node:crypto';
import { warnQualityPersistenceFailure } from './persistence-diagnostics.js';
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
   * Max evaluators calling the provider at once. Legacy classifiers share
   * one provider quota, so firing all five simultaneously every turn is what
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

/** Perf W4 — consecutive all-system-error calls before a session stops
 * classifying. Telemetry showed 24% of verdicts were classifier INFRA
 * failures (broken binding / provider timeouts) — each one still paying the
 * full timeout per turn. A single healthy verdict resets the streak. */
const SYSTEM_ERROR_BREAKER_THRESHOLD = 5;
/** Bound the per-session streak map (sessions are transient). */
const BREAKER_MAP_CAP = 500;

export class QualityClassifierPipeline {
  constructor(private opts: QualityClassifierPipelineOptions) {}

  private readonly systemErrorStreaks = new Map<string, number>();
  private breakerKey(output: AgentOutputForClassification): string {
    return `${output.sessionId ?? ''}:${output.companySessionId ?? ''}`;
  }

  /** Run all classifiers in parallel. Never throws. */
  async classify(output: AgentOutputForClassification): Promise<QualityResult> {
    const started = performance.now();
    const assessmentId = randomUUID();

    // Perf W4 — circuit breaker: after N consecutive calls where EVERY
    // verdict was a systemError, the classifier infra is down for this
    // session (unparseable model / dead binding / timeout storm). Skip the
    // provider calls instead of burning a full timeout per turn; the streak
    // entry lives until the process recycles or a healthy call resets it.
    const breakerKey = this.breakerKey(output);
    const streak = this.systemErrorStreaks.get(breakerKey) ?? 0;
    if (streak >= SYSTEM_ERROR_BREAKER_THRESHOLD) {
      return {
        verdicts: [],
        worstVerdict: 'ok',
        durationMs: 0,
        assessmentId,
      };
    }
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

    const baseVerdicts: ClassificationVerdict[] = settled.map((r, i): ClassificationVerdict => {
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
    const verdicts: ClassificationVerdict[] = baseVerdicts.flatMap((verdict) => {
      const dimensions = verdict.dimensions ?? [];
      const overall = { ...verdict, dimensions: undefined };
      return [
        overall,
        ...dimensions.map((dimension) => ({
          ...dimension,
          latencyMs: verdict.latencyMs,
          providerId: verdict.providerId,
          modelId: verdict.modelId,
          // Request-level usage belongs on the overall row only so KPI sums
          // do not multiply tokens by the four dimensional rows.
          tokensIn: undefined,
          tokensOut: undefined,
          providerRequests: undefined,
        })),
      ];
    });

    // Optional persistence — one row per classifier verdict.
    if (this.opts.store) {
      let persistenceError: unknown;
      for (const v of verdicts) {
        const row: QualityClassificationInsert = {
          session_id: output.sessionId ?? null,
          company_session_id: output.companySessionId ?? null,
          agent_run_id: output.agentRunId ?? null,
          coder_run_id: output.coderRunId ?? null,
          parent_run_id: output.parentRunId ?? null,
          is_subagent: output.isSubagent === true,
          subagent_profile: output.subagentProfile ?? null,
          message_id: output.messageId ?? null,
          assessment_id: assessmentId,
          round_message_id: output.roundMessageId ?? null,
          scope: 'run_final',
          source: 'terminal_llm',
          action_taken: v.systemError ? 'none' : v.verdict === 'ok' ? 'none' : 'advisory',
          evidence: {
            stopReason: output.stopReason ?? null,
            changedFiles: output.changedFiles ?? [],
            toolSummary: output.toolSummary ?? null,
            guardActions: output.guardActions ?? [],
            validationSignals: output.validationSignals ?? [],
          },
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
          tokens_in: v.tokensIn ?? null,
          tokens_out: v.tokensOut ?? null,
          provider_requests: v.providerRequests ?? 0,
          raw_response: v.raw,
        };
        try { this.opts.store.insert(row); }
        catch (error) { persistenceError ??= error; }
      }
      if (persistenceError != null) {
        warnQualityPersistenceFailure(`assessment ${assessmentId}`, persistenceError);
      }
    }

    const durationMs = performance.now() - started;

    // Perf W4 — feed the circuit breaker: a call where EVERY verdict failed
    // on infra bumps the streak; any healthy verdict clears it.
    if (verdicts.length > 0 && verdicts.every((v) => v.systemError)) {
      const next = streak + 1;
      this.systemErrorStreaks.set(breakerKey, next);
      if (next === SYSTEM_ERROR_BREAKER_THRESHOLD) {
        console.warn(
          `[quality] classifier breaker OPEN for session ${breakerKey} — ` +
            `${next} consecutive all-system-error runs; skipping further classification`,
        );
      }
      // Bounded map: evict the oldest entry (insertion order) past the cap.
      if (this.systemErrorStreaks.size > BREAKER_MAP_CAP) {
        const oldest = this.systemErrorStreaks.keys().next().value;
        if (oldest !== undefined) this.systemErrorStreaks.delete(oldest);
      }
    } else if (streak > 0) {
      this.systemErrorStreaks.delete(breakerKey);
    }

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

    return { verdicts, worstVerdict: worstOf(verdicts), durationMs, assessmentId };
  }
}
