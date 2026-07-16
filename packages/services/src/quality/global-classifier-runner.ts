/**
 * Global classifier runner — module-level holder for the quality pipeline.
 *
 * The runtime (CoderRunner) doesn't know about `@mcp/services/quality`
 * directly — the terminal dispatcher calls `runGlobalQualityClassifiers`
 * once after a completed main round. When boot installed a pipeline (and the
 * env flag is on), the call runs the configured passive evaluator and
 * persists verdicts to `quality_classifications`. Otherwise it's a no-op.
 *
 * Mirror of `setGlobalToolSelectionFilter` from the tool-selection module
 * — same singleton-holder pattern the codebase uses for cross-cutting
 * concerns (`setCompanySandboxStore`, `setEnvToolStore`, …).
 *
 * The store is also used by deterministic runtime guards. Legacy reader and
 * observer setters remain exported for compatibility but are not boot-wired.
 */
import type { AgentOutputForClassification, QualityResult } from './types.js';
import type { QualityClassifierPipeline } from './quality-pipeline.js';
import type { QualityClassificationStore } from '@mcp/store/quality-classification-store.js';
import { randomUUID } from 'node:crypto';
import type { QualityInterventionStore } from '@mcp/store/quality-intervention-store.js';

let globalPipeline: QualityClassifierPipeline | undefined;
let enabled = false;
let globalStore: QualityClassificationStore | undefined;
let globalInterventionStore: QualityInterventionStore | undefined;
let globalObserver: QualityResultObserver | undefined;

/** Callback invoked after every successful pipeline.classify() call.
 *  Must never throw — handler errors are swallowed by the dispatcher. */
export type QualityResultObserver = (
  result: QualityResult,
  output: AgentOutputForClassification,
) => void;

/**
 * Install the global quality pipeline. Called once during app boot with
 * `setGlobalQualityClassifierPipeline(deps.qualityClassifierPipeline, enabled)`.
 *
 * @param pipeline the wired pipeline (or undefined to clear)
 * @param isEnabled whether the env flag is set; even with a pipeline
 *   installed, the runtime can skip classification entirely when off
 */
export function setGlobalQualityClassifierPipeline(
  pipeline: QualityClassifierPipeline | undefined,
  isEnabled: boolean,
): void {
  globalPipeline = pipeline;
  enabled = isEnabled;
}

export function isGlobalQualityClassifierEnabled(): boolean {
  return enabled && globalPipeline != null;
}

/**
 * Install the read-side store. Decoupled from the pipeline because some
 * feature-flag combinations want the read side without the write side
 * (e.g. running classifiers manually for debugging while the agent still
 * benefits from past verdicts).
 */
export function setGlobalQualityClassificationStore(
  store: QualityClassificationStore | undefined,
): void {
  globalStore = store;
}

export function getGlobalQualityClassificationStore(): QualityClassificationStore | undefined {
  return globalStore;
}

/**
 * Quality v2, C4 — Install the intervention store. The runner inserts a
 * `quality_interventions` row when a nudge / planning / policy block fires;
 * this module backfills the row's `outcome` when the NEXT classified turn's
 * verdicts land. Decoupled from the classification store so each can be
 * absent (e.g. tests not exercising effectiveness).
 */
export function setGlobalQualityInterventionStore(
  store: QualityInterventionStore | undefined,
): void {
  globalInterventionStore = store;
}

export function getGlobalQualityInterventionStore(): QualityInterventionStore | undefined {
  return globalInterventionStore;
}

/**
 * Register a single global observer. Subsequent calls REPLACE the previous
 * observer (we keep this single-slot deliberately — multiple subscribers
 * lead to ordering surprises). Pass `undefined` to clear.
 */
export function setGlobalQualityResultObserver(
  observer: QualityResultObserver | undefined,
): void {
  globalObserver = observer;
}

/**
 * Run the configured evaluator(s) on the agent's output. Returns the
 * structured result, or null when the pipeline isn't installed/enabled
 * (so callers can use `?.` chains without an undefined check).
 *
 * NEVER throws — the QualityClassifierPipeline already handles
 * per-classifier failures internally. Errors here are swallowed.
 *
 * After a successful classify() call, the registered observer (if any)
 * is invoked synchronously with the result. Observer errors are swallowed
 * — a buggy observer must not break the classifier path.
 */
export async function runGlobalQualityClassifiers(
  output: AgentOutputForClassification,
): Promise<QualityResult | null> {
  if (!enabled || !globalPipeline) return null;
  try {
    const result = await globalPipeline.classify(output);
    if (globalObserver) {
      try { globalObserver(result, output); } catch { /* swallow observer errors */ }
    }
    return result;
  } catch {
    return null;
  }
}

/** Persist an objective runtime signal without making an LLM request. */
export function recordGlobalDeterministicQualitySignal(input: {
  sessionId?: number | null;
  companySessionId?: number | null;
  agentRunId?: number | null;
  coderRunId?: string | null;
  roundMessageId?: number | null;
  classifierName: string;
  verdict: 'warn' | 'flagged';
  reason: string;
  scope?: 'run_final' | 'runtime';
  actionTaken: 'advisory' | 'tool_call_refused' | 'strategy_nudge';
  evidence?: unknown;
}): string | null {
  if (!globalStore) return null;
  const assessmentId = randomUUID();
  try {
    globalStore.insert({
      session_id: input.sessionId ?? null,
      company_session_id: input.companySessionId ?? null,
      agent_run_id: input.agentRunId ?? null,
      coder_run_id: input.coderRunId ?? null,
      assessment_id: assessmentId,
      round_message_id: input.roundMessageId ?? null,
      scope: input.scope ?? 'runtime',
      source: 'deterministic_guard',
      action_taken: input.actionTaken,
      classifier_name: input.classifierName,
      verdict: input.verdict,
      reason: input.reason,
      evidence: input.evidence,
    });
    return assessmentId;
  } catch {
    return null;
  }
}
