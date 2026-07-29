/**
 * Tree-sitter dispatch: worker pool by default, in-process fallback.
 *
 * Extraction is CPU-bound and was the largest source of main-thread
 * blocking during indexing, so with `isIndexWorkersEnabled()` (default ON)
 * it goes to the worker pool. Worker resolution spans three runtimes (tsx
 * dev via the _dev-bootstrap, compiled dist, packaged Electron/asar) — if
 * the pool turns out to be unusable in this environment (entry not found,
 * boot-crash degradation), we log ONCE and fall back to an in-process
 * `TreeSitterExtractor` for the rest of the process instead of failing
 * every index run.
 */
import { TreeSitterExtractor, type TreeSitterResult } from '@mcp/indexer/indexer/tree-sitter/index.js';
import { getIndexJobPool, isIndexWorkersEnabled } from '@mcp/indexer/workers/indexJob/client.js';

const DEFAULT_POOL_MIN_BYTES = 16 * 1024;

export interface TreeSitterDispatch {
  extract(filePath: string, content: string): Promise<TreeSitterResult>;
  dispose(): void;
}

/** Small files parse faster locally than they can be cloned into a worker. */
export function resolveTreeSitterPoolMinBytes(): number {
  const raw = process.env.MCP_INDEX_POOL_MIN_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_POOL_MIN_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : DEFAULT_POOL_MIN_BYTES;
}

/** Sticky per-process fallback — worker spawning is broken for the whole process, not per run. */
let poolBroken = false;

/** Errors that mean "the worker itself cannot run here", not "this file failed". */
function isStickyEnvironmentError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  if (!e) return false;
  if (e.code === 'POOL_DEGRADED' || e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'ERR_WORKER_PATH') return true;
  return (e.message ?? '').includes('Cannot find module');
}

/**
 * A lone worker crash ("worker exited with code N") may be a pathological
 * file (wasm OOM) rather than a broken environment — retry that one file
 * in-process without giving up on the pool (which respawns with backoff;
 * persistent crashing converges to POOL_DEGRADED above).
 */
function isRetryableWorkerExit(err: unknown): boolean {
  return err instanceof Error && err.message.includes('worker exited');
}

/** Test hook: clear the sticky fallback (a new pool may work after close+recreate). */
export function resetTreeSitterDispatchFallback(): void {
  poolBroken = false;
}

export function buildTreeSitterDispatch(): TreeSitterDispatch {
  if (!isIndexWorkersEnabled() || poolBroken) {
    return new TreeSitterExtractor();
  }

  const poolMinBytes = resolveTreeSitterPoolMinBytes();
  // One lazy local extractor serves cheap sub-threshold parses and retries
  // after a pool crash. The surrounding indexer worker already isolates this
  // synchronous work from Electron main.
  let local: TreeSitterExtractor | null = null;
  const extractLocal = (filePath: string, content: string): Promise<TreeSitterResult> => {
    local ??= new TreeSitterExtractor();
    return local.extract(filePath, content);
  };

  return {
    async extract(filePath, content) {
      if (Buffer.byteLength(content, 'utf8') < poolMinBytes) {
        return extractLocal(filePath, content);
      }
      if (!poolBroken) {
        try {
          return await getIndexJobPool().extract(filePath, content);
        } catch (err) {
          // Diagnostic/test mode: prove the nested pool itself works instead
          // of allowing the normal resilience fallback to mask a boot defect.
          if (process.env.MCP_INDEX_POOL_STRICT === '1') throw err;
          if (isStickyEnvironmentError(err)) {
            poolBroken = true;
            console.error(
              `[indexer] tree-sitter worker pool unusable in this environment — falling back to in-process parsing: ${err instanceof Error ? err.message : String(err)}`,
            );
          } else if (!isRetryableWorkerExit(err)) {
            throw err;
          }
          // fall through: retry this file in-process
        }
      }
      return extractLocal(filePath, content);
    },
    dispose() {
      // The pool persists across runs (process-level lifecycle); only the
      // in-process extractor belongs to this run.
      local?.dispose();
      local = null;
    },
  };
}
