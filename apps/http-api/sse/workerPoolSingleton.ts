/**
 * Lazy singleton for the worker-backed orchestrator pool.
 *
 * Created on first access so processes that don't use the worker
 * path (CLI, tests) don't spawn any worker threads.
 *
 * Path resolution & dev support:
 *   - Production (`npm run start:api`): loads
 *     `dist/apps/http-api/workers/company-worker.js`.
 *   - Dev (`npm run dev:server` / `npm run electron:dev` with tsx):
 *     loads `apps/http-api/workers/company-worker.ts` and spawns the
 *     worker with a bootstrap `.mjs` that registers tsx itself. See
 *     `workerFileResolution.ts`.
 *
 * Architecture invariant: workers are the ONLY path for company
 * orchestrators. There is no in-process fallback. `startServer` checks
 * `describeWorkerOrchestratorStatus` at boot and exits if the worker
 * file can't be resolved (no silent degradation).
 */
import { loadConfig } from '@mcp/shared/utils/config.js';
import { WorkerOrchestratorPool } from './WorkerOrchestratorPool.js';
import { resolveWorkerFile, type ResolvedWorker } from './workerFileResolution.js';

let cachedPool: WorkerOrchestratorPool | null = null;

function tryResolve(): ResolvedWorker | null {
  return resolveWorkerFile(import.meta.url, 'company-worker');
}

export interface WorkerOrchestratorStatus {
  enabled: boolean;
  resolved: ResolvedWorker | null;
  reason: string | null;
}

/**
 * Diagnostic — returns the actual file path the pool would use, or
 * the reason it can't. The startup banner and the `/api/admin/workers`
 * endpoint surface this so the operator doesn't need to grep.
 */
export function describeWorkerOrchestratorStatus(): WorkerOrchestratorStatus {
  const resolved = tryResolve();
  if (!resolved) {
    return {
      enabled: false,
      resolved: null,
      reason:
        'company-worker.{js,ts} not found — run `npm run build` for production, ' +
        'or `npm run dev:server` / `npm run electron:dev` so tsx loads the TS source directly',
    };
  }
  return {
    enabled: true,
    resolved,
    reason: resolved.built
      ? `built worker at ${resolved.file}`
      : `TS source via tsx at ${resolved.file}`,
  };
}

export function getWorkerOrchestratorPool(): WorkerOrchestratorPool {
  if (cachedPool) return cachedPool;
  const resolved = tryResolve();
  if (!resolved) {
    throw new Error(
      '[orchestrator-pool] worker file not found. Run `npm run build` for ' +
        'production, or `npm run dev:server` / `npm run electron:dev` so tsx ' +
        'can load the TS source directly.',
    );
  }
  const { dbPath } = loadConfig();
  cachedPool = new WorkerOrchestratorPool({
    workerFile: resolved.file,
    workerExecArgv: resolved.execArgv,
    workerDevTsEntry: resolved.devTsEntry,
    dbPath,
    ttlMs: Number(process.env.CODER_COMPANY_ORCHESTRATOR_TTL_MS) || undefined,
    log: (level, msg) => {
      if (level === 'error') console.error(msg);
      else if (level === 'warn') console.warn(msg);
      else console.log(msg);
    },
  });
  return cachedPool;
}

/** Force-shutdown the pool — called from process shutdown hooks. */
export async function disposeWorkerOrchestratorPool(): Promise<void> {
  if (!cachedPool) return;
  const pool = cachedPool;
  cachedPool = null;
  await pool.dispose();
}
