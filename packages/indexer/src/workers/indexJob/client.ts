import os from 'node:os';
import { createPool, resolveWorkerSpec, type Pool } from '@mcp/indexer/workers/pool.js';
import type { IndexJobReq, IndexJobRes } from '@mcp/indexer/workers/indexJob/protocol.js';
import type { TreeSitterResult } from '@mcp/indexer/indexer/tree-sitter/index.js';

export interface IndexJobPool {
  extract(filePath: string, content: string): Promise<TreeSitterResult>;
  hashTree(pkgDir: string, excludeDirs?: string[]): Promise<string>;
  size(): number;
  close(): Promise<void>;
}

const resolveSize = (): number => {
  const fromEnv = process.env.MCP_INDEX_WORKERS;
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const cores = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  // Desktop default: two large-file parsers retained most of the measured
  // throughput gain while avoiding the multi-hundred-MB RSS jump of 4–8 WASM
  // isolates. Operators can still size explicitly with MCP_INDEX_WORKERS.
  return Math.max(1, Math.min(2, cores - 1));
};

/**
 * Idle TTL for the tree-sitter workers. Index runs come in bursts; two
 * minutes of silence means the run is over and the pool's N wasm isolates
 * (tens of MB each) can go back to the OS — the next run respawns lazily
 * (~100-300ms/worker). Default lives in code; env is an operator override
 * (`MCP_INDEX_POOL_IDLE_TTL_MS`, 0 = keep workers forever).
 */
const DEFAULT_POOL_IDLE_TTL_MS = 120_000;

const resolvePoolIdleTtlMs = (): number => {
  const raw = Number(process.env.MCP_INDEX_POOL_IDLE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_POOL_IDLE_TTL_MS;
};

const createWorkerIndexJobPool = (size: number): IndexJobPool => {
  const spec = resolveWorkerSpec(import.meta.url, './worker');
  const pool: Pool<IndexJobReq, IndexJobRes> = createPool({
    workerUrl: spec.url,
    size,
    name: 'indexJob',
    idleTtlMs: resolvePoolIdleTtlMs(),
    workerData: spec.bootstrapData ? { ...spec.bootstrapData } : undefined,
  });

  return {
    async extract(filePath, content) {
      const res = await pool.dispatch({ kind: 'extract', filePath, content });
      if (res.kind !== 'extract') {
        throw new Error(`unexpected indexJob response: ${res.kind}`);
      }
      return res.result;
    },
    async hashTree(pkgDir, excludeDirs) {
      const res = await pool.dispatch({ kind: 'hashTree', pkgDir, excludeDirs });
      if (res.kind !== 'hashTree') {
        throw new Error(`unexpected indexJob response: ${res.kind}`);
      }
      return res.digest;
    },
    size() { return pool.size(); },
    close() { return pool.close(); },
  };
};

let singleton: IndexJobPool | null = null;

export const getIndexJobPool = (): IndexJobPool => {
  if (!singleton) {
    const size = resolveSize();
    singleton = createWorkerIndexJobPool(size);
    console.error(`[indexer] tree-sitter worker pool: ${size} thread(s) (MCP_INDEX_WORKERS=0 disables)`);
  }
  return singleton;
};

export const closeIndexJobPool = async (): Promise<void> => {
  if (!singleton) return;
  const p = singleton;
  singleton = null;
  await p.close();
};

/**
 * Workers are ON by default — tree-sitter parsing off the main thread is
 * the difference between an index run and a frozen event loop in the
 * desktop app. `MCP_INDEX_WORKERS` is an operator override: `0`/`off`/
 * `false` forces in-process parsing; a number both enables and sizes the
 * pool. The default (unset) used to be OFF, which left the whole pool
 * dormant in production.
 */
export const isIndexWorkersEnabled = (): boolean => {
  const v = (process.env.MCP_INDEX_WORKERS ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false');
};
