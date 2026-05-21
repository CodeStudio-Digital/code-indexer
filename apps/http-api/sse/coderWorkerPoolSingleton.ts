/**
 * Lazy singleton for the coder worker pool (P17). Mirrors
 * `workerPoolSingleton.ts` (company) for the simpler coder path.
 *
 * Dev support: when running under `tsx`, falls back to the `.ts`
 * source and spawns the worker with `--import tsx/esm`. See
 * `workerFileResolution.ts` for the detection logic.
 */
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CoderWorkerPool } from './CoderWorkerPool.js';
import { resolveWorkerFile, type ResolvedWorker } from './workerFileResolution.js';

let cachedPool: CoderWorkerPool | null = null;

function tryResolve(): ResolvedWorker | null {
  return resolveWorkerFile(import.meta.url, 'coder-worker');
}

export interface CoderWorkerStatus {
  enabled: boolean;
  envFlag: boolean;
  resolved: ResolvedWorker | null;
  reason: string | null;
}

export function describeCoderWorkerStatus(): CoderWorkerStatus {
  const envFlag = process.env.MCP_CODER_WORKER === '1';
  if (!envFlag) {
    return { enabled: false, envFlag, resolved: null, reason: 'MCP_CODER_WORKER not set' };
  }
  const resolved = tryResolve();
  if (!resolved) {
    return {
      enabled: false,
      envFlag,
      resolved: null,
      reason:
        'coder-worker.{js,ts} not found — run `npm run build` for production, ' +
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

export function getCoderWorkerPool(): CoderWorkerPool {
  if (cachedPool) return cachedPool;
  const resolved = tryResolve();
  if (!resolved) {
    throw new Error(
      '[coder-pool] worker file not found. Run `npm run build` for production, ' +
        'or use `npm run dev:server` so tsx can load the TS source directly. ' +
        'Unset MCP_CODER_WORKER to fall back to in-process runCoder.',
    );
  }
  const { dbPath } = loadConfig();
  cachedPool = new CoderWorkerPool({
    workerFile: resolved.file,
    workerExecArgv: resolved.execArgv,
    workerDevTsEntry: resolved.devTsEntry,
    dbPath,
    ttlMs: Number(process.env.CODER_WORKER_TTL_MS) || undefined,
    postRunLingerMs: Number(process.env.CODER_WORKER_POST_RUN_LINGER_MS) || undefined,
    log: (level, msg) => {
      if (level === 'error') console.error(msg);
      else if (level === 'warn') console.warn(msg);
      else console.log(msg);
    },
  });
  return cachedPool;
}

export function coderWorkerEnabled(): boolean {
  if (process.env.MCP_CODER_WORKER !== '1') return false;
  return tryResolve() !== null;
}

export async function disposeCoderWorkerPool(): Promise<void> {
  if (!cachedPool) return;
  const pool = cachedPool;
  cachedPool = null;
  await pool.dispose();
}
