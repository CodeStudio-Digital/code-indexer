/**
 * Production LspBackendExecutor factory — worker-backed when the worker
 * file resolves (and the kill switch is off), with per-call fallback to
 * the in-process executor when the worker is UNAVAILABLE (missing build,
 * crash cooldown, port closed). Timeouts deliberately do NOT fall back:
 * re-running a slow op synchronously on the main thread would reintroduce
 * the exact stall the worker exists to remove — slow answers become empty.
 */
import { ErrRequestTimeout } from '@mcp/orchestrator-host';
import {
  EMPTY_RESULTS as LSP_EMPTY_RESULTS,
  type LspBackendExecutor,
  type LspExecutorOp,
  type LspOpCtx,
} from '@mcp/api-handlers/lsp/executor-types.js';
import { performance } from 'node:perf_hooks';
import { resolveWorkerFile } from './workerFileResolution.js';
import { LspWorkerClient } from './LspWorkerClient.js';
import { recordSlowCall } from '../server/perf/slow-ipc.js';

/** Fallback runs at or above this are worth surfacing (matches slow-ipc). */
const SLOW_FALLBACK_MS = 50;

function isTimeout(err: unknown): boolean {
  return err instanceof ErrRequestTimeout
    || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'request_timeout');
}

/** Wrap every op: worker error → in-process fallback; timeout → empty. */
export function wrapLspExecutorWithFallback(
  primary: LspBackendExecutor,
  fallback: LspBackendExecutor,
): LspBackendExecutor {
  const ops = Object.keys(LSP_EMPTY_RESULTS) as LspExecutorOp[];
  const wrapped = {} as Record<LspExecutorOp, (ctx: LspOpCtx) => Promise<unknown>>;
  const warnedOps = new Set<LspExecutorOp>();
  for (const op of ops) {
    wrapped[op] = async (ctx: LspOpCtx) => {
      try {
        return await (primary[op] as (c: LspOpCtx) => Promise<unknown>)(ctx);
      } catch (err) {
        if (isTimeout(err)) return LSP_EMPTY_RESULTS[op];
        // The fallback keeps the feature working, but it runs the full TS
        // LanguageService ON THE CALLING THREAD — in Electron that is the main
        // thread, and these ops have been observed taking >10s. Silently
        // degrading here made that invisible, so: warn once per op, and mark it
        // as a sync section so the freeze journal can name it.
        if (!warnedOps.has(op)) {
          warnedOps.add(op);
          console.warn(
            `[lsp-worker] op '${op}' fell back to in-process execution (runs on the caller's thread): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // Wall time, NOT sync time: the fallback is async-shaped, so timing it
        // across the await would inflate the busy accountant with time the
        // thread was not actually blocked — the very conflation that made
        // `timeCall` useless for attribution. It goes to the slow-call table,
        // where wall time is the right measure.
        const startedAt = performance.now();
        try {
          return await (fallback[op] as (c: LspOpCtx) => Promise<unknown>)(ctx);
        } finally {
          const ms = performance.now() - startedAt;
          if (ms >= SLOW_FALLBACK_MS) recordSlowCall(`lsp-fallback:${op}`, ms);
        }
      }
    };
  }
  return wrapped as unknown as LspBackendExecutor;
}

export function createLspExecutor(
  opts: { dbPath: string; idleTtlMs?: number },
  fallback: LspBackendExecutor,
): { executor: LspBackendExecutor; client: LspWorkerClient | null } {
  if (process.env.MCP_LSP_WORKER === '0') {
    return { executor: fallback, client: null };
  }
  const resolved = resolveWorkerFile(import.meta.url, 'lsp-worker');
  if (!resolved) {
    console.warn('[lsp-worker] worker entry not found — language compute runs on the main thread');
    return { executor: fallback, client: null };
  }
  const idleTtlMs = opts.idleTtlMs
    ?? (Number(process.env.MCP_LSP_WORKER_IDLE_MS) > 0 ? Number(process.env.MCP_LSP_WORKER_IDLE_MS) : undefined);
  const client = new LspWorkerClient({ dbPath: opts.dbPath, idleTtlMs }, resolved);
  return { executor: wrapLspExecutorWithFallback(client, fallback), client };
}
