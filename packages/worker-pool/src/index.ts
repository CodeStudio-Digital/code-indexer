/**
 * @mcp/worker-pool — dynamic worker_threads pool with per-kind min/max
 * and idle eviction. Used by the LSP service (Day 9) and the indexer
 * pipeline; the existing coder worker pool migrates onto this in a
 * follow-up rather than racing the IDE ship.
 */

export { WorkerPool } from './pool.js';
export type {
  WorkerKind,
  WorkerSpec,
  KindConfig,
  KindStats,
  PoolStats,
  PooledWorker,
} from './types.js';
export { WorkerPoolSaturatedError } from './types.js';
