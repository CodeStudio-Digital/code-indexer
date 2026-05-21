/**
 * Lazy singleton for the worker-backed orchestrator pool (P13).
 *
 * Created on first access so processes that don't use the worker
 * path (CLI, tests) don't spawn any worker threads.
 *
 * Path resolution & dev support:
 *   - Production (`npm run start:api`): loads
 *     `dist/apps/http-api/workers/company-worker.js`.
 *   - Dev (`npm run dev:server` with tsx): loads
 *     `apps/http-api/workers/company-worker.ts` and spawns the
 *     worker with `--import tsx/esm` so the worker thread also
 *     resolves TypeScript imports. See `workerFileResolution.ts`.
 *
 * Feature flag: routes opt in to the worker path with
 * `process.env.MCP_ORCHESTRATOR_WORKER === '1'`. `workerOrchestratorEnabled`
 * goes further: it ALSO checks that a worker file actually exists,
 * because in a misconfigured environment the flag would silently
 * fall back to the legacy path and confuse operators.
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
  envFlag: boolean;
  resolved: ResolvedWorker | null;
  reason: string | null;
}

/**
 * Diagnostic — returns the actual file path the pool would use,
 * or the reason it can't. The startup banner and the
 * `/api/admin/workers` endpoint surface this so the operator
 * doesn't need to grep.
 */
export function describeWorkerOrchestratorStatus(): WorkerOrchestratorStatus {
  const envFlag = process.env.MCP_ORCHESTRATOR_WORKER === '1';
  if (!envFlag) {
    return { enabled: false, envFlag, resolved: null, reason: 'MCP_ORCHESTRATOR_WORKER not set' };
  }
  const resolved = tryResolve();
  if (!resolved) {
    return {
      enabled: false,
      envFlag,
      resolved: null,
      reason:
        'company-worker.{js,ts} not found — run `npm run build` for production, ' +
        'or `npm run dev:server` so tsx loads the TS source directly',
    };
  }
  return {
    enabled: true,
    envFlag,
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
        'production, or use `npm run dev:server` so tsx can load the TS source ' +
        'directly. Unset MCP_ORCHESTRATOR_WORKER to fall back to the in-process registry.',
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

/**
 * Cheap predicate used by every route + the registry fallback.
 * Returns false when the env flag is unset OR when no worker file
 * can be resolved — so a half-set environment falls through to the
 * legacy in-process path rather than crashing on first /start.
 */
export function workerOrchestratorEnabled(): boolean {
  if (process.env.MCP_ORCHESTRATOR_WORKER !== '1') return false;
  return tryResolve() !== null;
}

/** Force-shutdown the pool — called from process shutdown hooks. */
export async function disposeWorkerOrchestratorPool(): Promise<void> {
  if (!cachedPool) return;
  const pool = cachedPool;
  cachedPool = null;
  await pool.dispose();
}
