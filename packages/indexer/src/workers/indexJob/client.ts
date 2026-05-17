import os from 'node:os';
import { createPool, resolveWorkerUrl, type Pool } from '@mcp/indexer/workers/pool.js';
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
  return Math.max(2, Math.min(8, cores));
};

const createWorkerIndexJobPool = (size: number): IndexJobPool => {
  const pool: Pool<IndexJobReq, IndexJobRes> = createPool({
    workerUrl: resolveWorkerUrl(import.meta.url, './worker'),
    size,
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
    singleton = createWorkerIndexJobPool(resolveSize());
  }
  return singleton;
};

export const closeIndexJobPool = async (): Promise<void> => {
  if (!singleton) return;
  const p = singleton;
  singleton = null;
  await p.close();
};

export const isIndexWorkersEnabled = (): boolean => {
  const v = process.env.MCP_INDEX_WORKERS;
  if (!v) return false;
  if (v === '0' || v === 'off' || v === 'false') return false;
  return true;
};
