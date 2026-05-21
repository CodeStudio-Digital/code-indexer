/**
 * Global classifier runner — module-level holder for the quality pipeline.
 *
 * The runtime (CoderRunner) doesn't know about `@mcp/services/quality`
 * directly — it just calls `runGlobalQualityClassifiers(output)` after a
 * turn completes. When the boot path has installed a pipeline (and the
 * env flag is on), the call runs the 5 classifiers in parallel and
 * persists verdicts to `quality_classifications`. Otherwise it's a no-op.
 *
 * Mirror of `setGlobalToolSelectionFilter` from the tool-selection module
 * — same singleton-holder pattern the codebase uses for cross-cutting
 * concerns (`setCompanySandboxStore`, `setEnvToolStore`, …).
 *
 * In addition to the write side, this module also publishes:
 *
 *   1. A **READER** — `getGlobalQualityClassificationStore()` — used by
 *      the runner to peek at recent verdicts when building the next
 *      system prompt (Wire #1 nudge, Wire #2 tool-misuse streak).
 *
 *   2. An **OBSERVER** — `setGlobalQualityResultObserver()` — invoked
 *      with the just-computed result + output. Cross-cutting concerns
 *      (Wire #4 off-topic→inbox) register here at boot to react without
 *      coupling the pipeline to company-side services.
 *
 * Both are opt-in: nothing fires when nothing is installed.
 */
import type { AgentOutputForClassification, QualityResult } from './types.js';
import type { QualityClassifierPipeline } from './quality-pipeline.js';
import type { QualityClassificationStore } from '@mcp/store/quality-classification-store.js';
import type { QualityInterventionStore } from '@mcp/store/quality-intervention-store.js';
import { computeOutcome } from './feedback-builder.js';

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
 * Run the 5 classifiers in parallel on the agent's output. Returns the
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
    // Quality v2, C4 — Backfill any pending interventions whose
    // "next-turn" is THIS turn's classification. Outcome is computed via
    // `computeOutcome` (improved/unchanged/worsened). Done synchronously
    // with the classify() resolution so the dashboard reflects the answer
    // as soon as the row lands.
    try {
      backfillPendingInterventions(result, output);
    } catch { /* never break the classifier path */ }
    return result;
  } catch {
    return null;
  }
}

/**
 * Quality v2, C4 — Walk the pending interventions for `(sessionId,
 * turn_fired = currentTurn - 1)` and record the outcome based on this
 * turn's verdicts.
 *
 * Why one turn behind: when intervention fires at turn N, we want to know
 * if the model's response at turn N+1 was better. Turn N+1 produces a
 * classify result; this function looks back to turn N and resolves any
 * pending rows.
 */
function backfillPendingInterventions(
  result: QualityResult,
  output: AgentOutputForClassification,
): void {
  const store = globalInterventionStore;
  if (!store) return;
  if (output.sessionId == null) return;
  // messageId format: "turn-N" — extract N.
  const m = (output.messageId ?? '').match(/^turn-(\d+)$/);
  if (!m) return;
  const currentTurn = Number(m[1]);
  if (!Number.isFinite(currentTurn) || currentTurn <= 0) return;
  const priorTurn = currentTurn - 1;
  const pending = store.findPendingByPriorTurn(output.sessionId, priorTurn);
  if (pending.length === 0) return;
  for (const row of pending) {
    let before: ReturnType<typeof parseVerdicts>;
    try { before = parseVerdicts(row.triggering_verdicts_json); }
    catch { continue; } // bad JSON — skip silently
    const after = result.verdicts.map((v) => ({
      classifierName: v.classifierName,
      verdict: v.verdict,
      confidence: v.confidence ?? null,
      reason: v.reason ?? null,
    }));
    const outcome = computeOutcome(before, after);
    try {
      store.recordOutcome({
        id: row.id,
        next_turn_verdicts: after,
        outcome,
      });
    } catch { /* never throw from backfill */ }
  }
}

function parseVerdicts(
  json: string,
): Array<{ classifierName: string; verdict: 'ok' | 'warn' | 'flagged' | 'error' }> {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) throw new Error('triggering_verdicts_json not an array');
  return parsed
    .filter((v): v is { classifierName: string; verdict: 'ok' | 'warn' | 'flagged' | 'error' } =>
      typeof v === 'object' && v !== null && 'classifierName' in v && 'verdict' in v,
    );
}
