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
import {
  WorkerOrchestratorPool,
  type CompanySessionRuntimeContext,
} from './WorkerOrchestratorPool.js';
import type { CoderWorkerDocDeps } from './CoderWorkerPool.js';
import { resolveWorkerFile, type ResolvedWorker } from './workerFileResolution.js';
import type { CompanySessionId } from '@mcp/session-storage';

let cachedPool: WorkerOrchestratorPool | null = null;
/**
 * Mutable box for doc-corpus deps. Server.ts populates it during boot via
 * `setCompanyWorkerDocDeps(...)`; `getWorkerOrchestratorPool()` passes the
 * SAME object into the pool, which reads it per-spawn — so deps wired
 * after the first spawn still reach subsequently-spawned workers. Mirrors
 * `coderWorkerPoolSingleton.ts` for the company path.
 */
const docDeps: CoderWorkerDocDeps = {};
const sessionRuntimeBox: {
  resolve:
    | ((
        sessionId: CompanySessionId,
      ) => Promise<CompanySessionRuntimeContext>)
    | null;
} = { resolve: null };

function tryResolve(): ResolvedWorker | null {
  return resolveWorkerFile(import.meta.url, 'company-worker');
}

interface WorkerOrchestratorStatus {
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
    resolveCompanySessionRuntimeContext: async (sessionId) => {
      const resolve = sessionRuntimeBox.resolve;
      if (!resolve) {
        throw new Error(
          '[orchestrator-pool] filesystem Company session resolver is not configured',
        );
      }
      return resolve(sessionId);
    },
    ttlMs: Number(process.env.CODER_COMPANY_ORCHESTRATOR_TTL_MS) || undefined,
    log: (level, msg) => {
      if (level === 'error') console.error(msg);
      else if (level === 'warn') console.warn(msg);
      else console.log(msg);
    },
    // Shared deps BOX (not a snapshot) — `setCompanyWorkerDocDeps` mutates
    // this same object the pool reads inside `spawn()`, so docs wiring that
    // lands after the first spawn still benefits later worker spawns.
    docDeps,
  });
  return cachedPool;
}

function peekWorkerOrchestratorPool(): WorkerOrchestratorPool | null {
  return cachedPool;
}

/**
 * Wire main-thread doc-corpus deps into the company worker pool. Called by
 * `server.ts` right after `DocHybridSearch` + `DocsResearchBridge` are
 * built so when the pool spawns company-workers, their `rag_search_docs`
 * and `docs_deep_research` tools can RPC back to these instances via
 * MessageBridge. Without this wire-up the company worker has no
 * `setGlobalDocSearch` singleton populated and both tools error out with
 * "not configured" at the first agent call. Mirrors `setCoderWorkerDocDeps`.
 *
 * Safe to call multiple times — fields are updated in-place. Pass `null`
 * to detach (tests).
 */
export function setCompanyWorkerDocDeps(
  deps: {
    indexSearch?: CoderWorkerDocDeps['indexSearch'];
    docSearch?: CoderWorkerDocDeps['docSearch'];
    docsResearch?: CoderWorkerDocDeps['docsResearch'];
    vision?: CoderWorkerDocDeps['vision'];
    recommend?: CoderWorkerDocDeps['recommend'];
    memoryRetriever?: CoderWorkerDocDeps['memoryRetriever'];
    runEndMemory?: CoderWorkerDocDeps['runEndMemory'];
    projectMemory?: CoderWorkerDocDeps['projectMemory'];
    investigationSemantic?: CoderWorkerDocDeps['investigationSemantic'];
  } | null,
): void {
  if (!deps) {
    for (const key of Object.keys(docDeps) as Array<keyof CoderWorkerDocDeps>) delete docDeps[key];
    return;
  }
  if (deps.indexSearch !== undefined) docDeps.indexSearch = deps.indexSearch;
  if (deps.docSearch !== undefined) docDeps.docSearch = deps.docSearch;
  if (deps.docsResearch !== undefined) docDeps.docsResearch = deps.docsResearch;
  if (deps.vision !== undefined) docDeps.vision = deps.vision;
  if (deps.recommend !== undefined) docDeps.recommend = deps.recommend;
  if (deps.memoryRetriever !== undefined) docDeps.memoryRetriever = deps.memoryRetriever;
  if (deps.runEndMemory !== undefined) docDeps.runEndMemory = deps.runEndMemory;
  if (deps.projectMemory !== undefined) docDeps.projectMemory = deps.projectMemory;
  if (deps.investigationSemantic !== undefined) docDeps.investigationSemantic = deps.investigationSemantic;
}

export function setCompanyWorkerSessionRuntimeResolver(
  resolve:
    | ((
        sessionId: CompanySessionId,
      ) => Promise<CompanySessionRuntimeContext>)
    | null,
): void {
  sessionRuntimeBox.resolve = resolve;
}

/** Force-shutdown the pool — called from process shutdown hooks. */
export async function disposeWorkerOrchestratorPool(): Promise<void> {
  if (!cachedPool) return;
  const pool = cachedPool;
  cachedPool = null;
  await pool.dispose();
}
