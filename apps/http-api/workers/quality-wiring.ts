/**
 * Worker-side quality-classifier wiring.
 *
 * `worker_threads` DON'T share module state, so the
 * `setGlobalQualityClassifierPipeline` / `setGlobalQualityClassificationStore`
 * calls in `apps/http-api/server.ts` (main thread) leave the quality globals
 * NULL inside a worker realm. The completed-round assessment runs inside the
 * coder/company worker, so each realm needs the same shared factory.
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
 * Active workers receive runtime toggle changes over RPC and ACK the effective
 * state; newly spawned workers receive the current state in workerData.
 */
import type DatabaseConstructor from 'better-sqlite3';
import {
  createQualityRuntime,
  setGlobalQualityClassifierPipeline,
  setGlobalQualityClassificationStore,
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
export interface WorkerQualityController {
  setEnabled(enabled: boolean): { enabled: boolean };
  isEnabled(): boolean;
}

export function installWorkerQualityWiring(
  db: DB,
  label: string,
  initialEnabled = process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS === '1',
): WorkerQualityController {
  let runtime: ReturnType<typeof createQualityRuntime> | null = null;
  let enabled = initialEnabled;
  try {
    runtime = createQualityRuntime(db);
    setGlobalQualityClassifierPipeline(runtime.pipeline, enabled);
    setGlobalQualityClassificationStore(runtime.classificationStore);
  } catch (err) {
    console.warn(
      `[${label}] failed to wire quality classifiers (continuing without them):`,
      err,
    );
  }
  return {
    setEnabled(next) {
      enabled = next;
      setGlobalQualityClassifierPipeline(runtime?.pipeline, next);
      return { enabled: runtime != null && next };
    },
    isEnabled: () => runtime != null && enabled,
  };
}
