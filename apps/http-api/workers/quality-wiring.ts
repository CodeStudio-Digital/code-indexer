/**
 * Worker-side quality-classifier wiring.
 *
 * `worker_threads` DON'T share module state, so the
 * `setGlobalQualityClassifierPipeline` / `setGlobalQualityClassificationStore`
 * / `setGlobalQualityInterventionStore` calls in `apps/http-api/server.ts`
 * (main thread) leave the quality globals NULL inside a worker realm. Since
 * the `CoderRunner` that actually fires `runGlobalQualityClassifiers(...)`
 * runs INSIDE the coder/company worker when `MCP_CODER_WORKER=1`, without
 * this re-install the per-turn classifiers never run and the Telemetry →
 * Quality dashboard stays empty forever (distribution all-zero) even though
 * the main-process toggle reads "ativa".
 *
 * This mirrors the in-process boot wiring (server.ts:259-271) but rebuilds
 * the instances from the worker's OWN SQLite handle — the same trick
 * `runCoder` already uses for `PipelineProviderResolver`
 * (packages/code-agent/src/index.ts:1623-1626).
 *
 * IMPORTANT: workers import via RELATIVE paths only. Node's loader resolves
 * these before tsx/tsconfig `paths`, so an alias like `@mcp/services/...`
 * throws "Cannot find package" inside a worker_thread. (Same note as the
 * top of coder-worker.ts / company-worker.ts.)
 *
 * Two deliberate gaps vs. the main process, documented for the next dev:
 *
 *   1. The Wire #4 board-alert OBSERVER (`makeQualityAlertObserver`) is NOT
 *      installed here — it depends on `getCompanyOrchestrator()`, which is
 *      main-process only. Quality counting/verdicts/effectiveness (what the
 *      dashboard shows) work without it; aggregated board alerts simply
 *      don't fire in worker mode. Follow-up: forward via the MessageBridge.
 *
 *   2. The runtime on/off toggle (`POST /api/admin/quality/enabled`) flips
 *      the global in the MAIN process only. Workers read the boot env flag
 *      `MCP_PIPELINES_QUALITY_CLASSIFIERS` at spawn time (inherited into
 *      `process.env` by `new Worker`), so toggling at runtime does NOT
 *      reach already-spawned workers. Follow-up: propagate via RPC.
 */
import type DatabaseConstructor from 'better-sqlite3';
import { ProviderStore } from '../../../packages/store/src/provider-store.js';
import { PipelineProviderBindingsStore } from '../../../packages/store/src/pipeline-provider-bindings-store.js';
import { QualityClassificationStore } from '../../../packages/store/src/quality-classification-store.js';
import { QualityInterventionStore } from '../../../packages/store/src/quality-intervention-store.js';
import { PipelineProviderResolver } from '../../../packages/services/src/pipelines/provider-resolver.js';
import {
  QualityClassifierPipeline,
  OffTopicClassifier,
  CompletenessClassifier,
  CodeQualityClassifier,
  PolicyClassifier,
  ToolMisuseClassifier,
  setGlobalQualityClassifierPipeline,
  setGlobalQualityClassificationStore,
  setGlobalQualityInterventionStore,
} from '../../../packages/services/src/quality/index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Install the quality globals into THIS worker realm. Best-effort: any
 * failure is logged and swallowed — the worker boot must never break
 * because the quality pipeline couldn't be wired.
 *
 * @param db      the worker's own better-sqlite3 handle (`dbConn.handle`)
 * @param label   short tag for log lines (e.g. `coder-worker 42`)
 */
export function installWorkerQualityWiring(db: DB, label: string): void {
  try {
    const resolver = new PipelineProviderResolver(
      new PipelineProviderBindingsStore(db),
      new ProviderStore(db),
    );
    const classificationStore = new QualityClassificationStore(db);
    const interventionStore = new QualityInterventionStore(db);
    const pipeline = new QualityClassifierPipeline({
      classifiers: [
        new OffTopicClassifier(resolver),
        new CompletenessClassifier(resolver),
        new CodeQualityClassifier(resolver),
        new PolicyClassifier(resolver),
        new ToolMisuseClassifier(resolver),
      ],
      store: classificationStore,
    });

    // Write side — per-turn classify() + persistence. Gated by the SAME env
    // flag the main process uses at boot (server.ts:259-262).
    setGlobalQualityClassifierPipeline(
      pipeline,
      process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS === '1',
    );
    // Read side — the runner peeks at recent verdicts when building each
    // next system prompt (Wire #1 nudge, Wire #2 tool-misuse streak).
    // Always installed; the runner short-circuits via the env flag.
    setGlobalQualityClassificationStore(classificationStore);
    // Intervention store — runner records nudge/planning/policy blocks; the
    // global runner backfills outcomes when the next classified turn lands
    // (powers the "Intervention effectiveness" panel).
    setGlobalQualityInterventionStore(interventionStore);
  } catch (err) {
    console.warn(
      `[${label}] failed to wire quality classifiers (continuing without them):`,
      err,
    );
  }
}
