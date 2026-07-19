/**
 * Lazy singleton for the coder worker pool (P17). Mirrors
 * `workerPoolSingleton.ts` (company) for the simpler coder path.
 *
 * Architecture invariant: coder sessions are workers-only. The environment
 * flag that used to opt into workers is intentionally ignored; if the worker
 * entry cannot be resolved, callers fail closed instead of running `runCoder`
 * on the Electron/backend main event loop.
 *
 * Dev support: when running under `tsx`, falls back to the `.ts`
 * source and spawns the worker with `--import tsx/esm`. See
 * `workerFileResolution.ts` for the detection logic.
 */
import { loadConfig } from '@mcp/shared/utils/config.js';
import {
  CoderWorkerPool,
  type CoderWorkerDocDeps,
} from './CoderWorkerPool.js';
import type { McpExternalPool } from './McpExternalPool.js';
import { resolveWorkerFile, type ResolvedWorker } from './workerFileResolution.js';

let cachedPool: CoderWorkerPool | null = null;
/**
 * Mutable box for doc-corpus deps. Server.ts populates it during boot via
 * `setCoderWorkerDocDeps(...)`; `getCoderWorkerPool()` reads it when the
 * pool is first instantiated AND keeps a reference, so updates after
 * the first call also propagate to subsequently-spawned workers.
 */
const docDeps: CoderWorkerDocDeps = {};
/**
 * Mutable box for the shared external-MCP pool. Set during boot via
 * `setCoderWorkerMcpPool(pool)` after `pool.boot()` resolves. The
 * `CoderWorkerPool` reads this reference each time it spawns a worker
 * (via `this.opts.mcpExternalPool`), so workers spawned BEFORE the
 * pool finishes booting fall back gracefully to the legacy
 * per-worker manager.
 */
const mcpPoolBox: { pool: McpExternalPool | null } = { pool: null };

function tryResolve(): ResolvedWorker | null {
  return resolveWorkerFile(import.meta.url, 'coder-worker');
}

export interface CoderWorkerStatus {
  enabled: boolean;
  resolved: ResolvedWorker | null;
  reason: string | null;
}

export function describeCoderWorkerStatus(): CoderWorkerStatus {
  const resolved = tryResolve();
  if (!resolved) {
    return {
      enabled: false,
      resolved: null,
      reason:
        'coder-worker.{js,ts} not found — run `npm run build` for production, ' +
        'or `npm run dev:server` so tsx loads the TS source directly',
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

export function getCoderWorkerPool(): CoderWorkerPool {
  if (cachedPool) return cachedPool;
  const resolved = tryResolve();
  if (!resolved) {
    throw new Error(
      '[coder-pool] worker file not found. Run `npm run build` for production, ' +
        'or use `npm run dev:server` / `npm run electron:dev` so tsx can load ' +
        'the TS source directly. In-process coder execution is not supported.',
    );
  }
  const { dbPath } = loadConfig();
  const configuredHeapMb = Number(process.env.CODER_WORKER_HEAP_MB);
  const workerHeapMb = Number.isFinite(configuredHeapMb) && configuredHeapMb >= 256
    ? Math.floor(configuredHeapMb)
    : 2_048;
  cachedPool = new CoderWorkerPool({
    workerFile: resolved.file,
    workerExecArgv: resolved.execArgv,
    workerDevTsEntry: resolved.devTsEntry,
    dbPath,
    workerMaxOldGenerationSizeMb: workerHeapMb,
    ttlMs: Number(process.env.CODER_WORKER_TTL_MS) || undefined,
    postRunLingerMs: Number(process.env.CODER_WORKER_POST_RUN_LINGER_MS) || undefined,
    log: (level, msg) => {
      if (level === 'error') console.error(msg);
      else if (level === 'warn') console.warn(msg);
      else console.log(msg);
    },
    // Pass the shared deps BOX (not a snapshot). Subsequent updates via
    // `setCoderWorkerDocDeps` mutate the same object the pool reads
    // inside `ensureEntry`, so adding deps after the first spawn still
    // benefits later worker spawns.
    docDeps,
    // Late-bound getter so the pool can be wired AFTER the http-api
    // starts serving requests; the first worker that spawns before
    // `setMcpExternalPool` runs simply sees `null` and falls back to
    // the legacy per-worker manager.
    getMcpExternalPool: () => mcpPoolBox.pool,
  });
  return cachedPool;
}

export function peekCoderWorkerPool(): CoderWorkerPool | null {
  return cachedPool;
}

/**
 * Wire main-thread doc-corpus deps into the coder worker pool. Called by
 * `server.ts` right after `DocHybridSearch` + `DocsResearchBridge` are
 * built so when the worker pool spawns workers, their `rag_search_docs`
 * and `docs_deep_research` tools can RPC back to these instances via
 * MessageBridge. Without this wire-up the worker process has no
 * `setGlobalDocSearch` singleton populated and both tools error out
 * with "not configured" at the first agent call.
 *
 * Safe to call multiple times — fields are updated in-place. Pass
 * `null` to detach (tests).
 */
export function setCoderWorkerDocDeps(
  deps: {
    docSearch?: CoderWorkerDocDeps['docSearch'];
    docsResearch?: CoderWorkerDocDeps['docsResearch'];
    vision?: CoderWorkerDocDeps['vision'];
    spriteStudioHost?: CoderWorkerDocDeps['spriteStudioHost'];
    memoryRetriever?: CoderWorkerDocDeps['memoryRetriever'];
    memoryQuerySynthesizer?: CoderWorkerDocDeps['memoryQuerySynthesizer'];
    runEndMemory?: CoderWorkerDocDeps['runEndMemory'];
    projectMemory?: CoderWorkerDocDeps['projectMemory'];
    investigationSemantic?: CoderWorkerDocDeps['investigationSemantic'];
  } | null,
): void {
  if (!deps) {
    for (const key of Object.keys(docDeps) as Array<keyof CoderWorkerDocDeps>) delete docDeps[key];
    return;
  }
  if (deps.docSearch !== undefined) docDeps.docSearch = deps.docSearch;
  if (deps.docsResearch !== undefined) docDeps.docsResearch = deps.docsResearch;
  if (deps.vision !== undefined) docDeps.vision = deps.vision;
  if (deps.spriteStudioHost !== undefined) docDeps.spriteStudioHost = deps.spriteStudioHost;
  if (deps.memoryRetriever !== undefined) docDeps.memoryRetriever = deps.memoryRetriever;
  if (deps.memoryQuerySynthesizer !== undefined) docDeps.memoryQuerySynthesizer = deps.memoryQuerySynthesizer;
  if (deps.runEndMemory !== undefined) docDeps.runEndMemory = deps.runEndMemory;
  if (deps.projectMemory !== undefined) docDeps.projectMemory = deps.projectMemory;
  if (deps.investigationSemantic !== undefined) docDeps.investigationSemantic = deps.investigationSemantic;
}

/**
 * Wire the shared external-MCP pool into the coder worker pool. The
 * pool boot can take a few seconds (each external MCP server does a
 * TLS handshake + listTools call), so server.ts calls this AFTER
 * `pool.boot()` resolves. Workers spawned before this point harmless
 * — `getMcpExternalPool` returns null until set, and the worker-side
 * snapshot RPC simply gets an empty list and skips external tools.
 */
export function setCoderWorkerMcpPool(pool: McpExternalPool | null): void {
  mcpPoolBox.pool = pool;
}

export async function disposeCoderWorkerPool(): Promise<void> {
  if (!cachedPool) return;
  const pool = cachedPool;
  cachedPool = null;
  await pool.dispose();
}
