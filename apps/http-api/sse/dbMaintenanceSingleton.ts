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
import type { ProjectSettingsRows } from '@mcp/store/db/projects.js';
import { resolveWorkerFile } from './workerFileResolution.js';

let cached: WorkerHost | null = null;
let cachedStart: Promise<void> | null = null;
const projectCheckpointInflight = new Set<string>();

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
      if (cached === host) {
        cached = null;
        cachedStart = null;
      }
      opts.onPermanentCrash?.();
    },
  });
  cached = host;
  cachedStart = host.start().then(() => undefined).catch((err: unknown) => {
    console.error(
      `[db-maintenance] failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (cached === host) cached = null;
    opts.onPermanentCrash?.();
  });
}

/**
 * Recover stale semantic mutation fences on the maintenance worker. Fence
 * resolution may inspect many source rows and acquire an IMMEDIATE
 * transaction; neither operation belongs on Electron-main during startup.
 */
export async function recoverSemanticMutationFences(
  prefixes: readonly string[],
  currentOwner: string,
): Promise<number | null> {
  const host = cached;
  const starting = cachedStart;
  if (!host || !starting) return null;
  await starting;
  if (cached !== host || !host.isRunning()) return null;
  const result = await host.requireBridge().request<{ recovered: number }>(
    'semantic.recover-mutation-fences',
    { prefixes: [...prefixes], currentOwner },
    { timeoutMs: 60_000 },
  );
  return result.recovered;
}

/** Read a project's settings without opening or closing its partition on Electron-main. */
export async function readProjectSettingsInWorker(
  dbPath: string,
  projectId: number,
): Promise<ProjectSettingsRows | undefined | null> {
  const host = cached;
  const starting = cachedStart;
  if (!host || !starting) return null;
  await starting;
  if (cached !== host || !host.isRunning()) return null;
  const result = await host.requireBridge().request<{ rows?: ProjectSettingsRows; busy?: true }>(
    'project.read-settings', { dbPath, projectId }, { timeoutMs: 15_000 },
  );
  if (result.busy) throw Object.assign(new Error('Project settings database is busy'), { code: 'SQLITE_BUSY' });
  return result.rows;
}

/**
 * Queue a project-DB PASSIVE checkpoint on the maintenance worker. Eviction is
 * synchronous, so this intentionally never waits on the Electron main thread.
 */
export function scheduleProjectDbCheckpoint(dbPath: string): void {
  const host = cached;
  if (!host?.isRunning() || projectCheckpointInflight.has(dbPath)) return;
  projectCheckpointInflight.add(dbPath);
  void host.requireBridge()
    .request('checkpoint.project', { dbPath }, { timeoutMs: 30_000 })
    .catch((error: unknown) => {
      console.warn(
        `[db-maintenance] project checkpoint failed for ${dbPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => projectCheckpointInflight.delete(dbPath));
}

/** Graceful shutdown (registered as a deps shutdown task). Idempotent. */
export async function stopDbMaintenanceWorker(): Promise<void> {
  const host = cached;
  cached = null;
  cachedStart = null;
  projectCheckpointInflight.clear();
  if (host) await host.evict();
}
