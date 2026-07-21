/**
 * Perf W2 — lazy singleton for the db-maintenance worker: WAL checkpointing
 * + central-DB retention OFF the Electron main thread (see
 * `workers/db-maintenance-worker.ts` for why).
 *
 * Boot contract with `deps.ts`:
 *   1. `canResolveDbMaintenanceWorker()` is checked SYNCHRONOUSLY before the
 *      central `CodeIndexDB` is constructed — it decides
 *      `externalCheckpointer` (the main handle must not silently end up with
 *      NO checkpointer anywhere).
 *   2. `startDbMaintenanceWorker(...)` spawns after the DB exists (so a
 *      first-ever boot creates the schema before the worker touches the
 *      file). `WorkerHost` restarts a crashed worker up to 3×; when the
 *      budget is exhausted `onPermanentCrash` fires so the caller can fall
 *      back to the in-process checkpoint timer.
 *
 * Kill switch: MCP_DB_MAINTENANCE=0 (checked by deps.ts — this module stays
 * env-agnostic).
 */
import { WorkerHost } from '@mcp/orchestrator-host';
import { resolveWorkerFile } from './workerFileResolution.js';

let cached: WorkerHost | null = null;

/** Sync probe used to decide `externalCheckpointer` before the DB opens. */
export function canResolveDbMaintenanceWorker(): boolean {
  return resolveWorkerFile(import.meta.url, 'db-maintenance-worker') !== null;
}

export function startDbMaintenanceWorker(
  dbPath: string,
  opts: { onPermanentCrash?: () => void } = {},
): void {
  if (cached) return;
  const resolved = resolveWorkerFile(import.meta.url, 'db-maintenance-worker');
  if (!resolved) {
    console.warn('[db-maintenance] worker entry not found — checkpoint stays in-process');
    opts.onPermanentCrash?.();
    return;
  }
  const host = new WorkerHost({
    name: 'db-maintenance',
    workerFile: resolved.file,
    execArgv: resolved.execArgv,
    workerData: { dbPath, tsEntry: resolved.devTsEntry },
    onCrash: (err) => {
      console.error(`[db-maintenance] worker crashed permanently: ${err.message}`);
      cached = null;
      opts.onPermanentCrash?.();
    },
  });
  cached = host;
  void host.start().catch((err: unknown) => {
    console.error(
      `[db-maintenance] failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    cached = null;
    opts.onPermanentCrash?.();
  });
}

/** Graceful shutdown (registered as a deps shutdown task). Idempotent. */
export async function stopDbMaintenanceWorker(): Promise<void> {
  const host = cached;
  cached = null;
  if (host) await host.evict();
}
