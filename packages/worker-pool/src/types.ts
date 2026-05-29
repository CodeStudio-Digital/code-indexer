/**
 * Public contract of the dynamic worker pool. Generic over the message
 * shapes each kind sends/receives, but the pool itself operates on
 * opaque Worker handles so it stays kind-agnostic.
 */

import type { Worker } from 'node:worker_threads';

/**
 * Buckets the pool manages independently — separate min/active counters,
 * separate auto-scale logic. Add new kinds here when a new CPU-heavy
 * workload appears.
 */
export type WorkerKind = 'coder' | 'lsp' | 'index' | 'plugin';

export interface WorkerSpec {
  /** Absolute path to the worker entry file (.js for prod, .ts under tsx). */
  file: string;
  /** Extra execArgv (e.g. `--import tsx/esm` in dev). */
  execArgv?: string[];
  /** Worker-side data passed once at startup (via workerData). */
  initData?: unknown;
}

/**
 * Per-kind tuning. All knobs override-able via env in the consumer.
 * Defaults match the plan: min=1 (pre-warmed), max=cpus*2 capped at 16,
 * idle timeout 5min.
 */
export interface KindConfig {
  spec: WorkerSpec;
  /** Workers always alive (pre-warmed). Default 1. */
  min?: number;
  /** Hard cap. Acquires beyond this size queue. Default min(cpus*2, 16). */
  max?: number;
  /** Terminate an idle worker after this many ms. Default 5 * 60_000. */
  idleTimeoutMs?: number;
  /**
   * How long an acquire is allowed to wait when the pool is at max and
   * everyone is busy. Default 30s. After this the acquire throws
   * `worker_pool_saturated`.
   */
  acquireTimeoutMs?: number;
}

export interface PooledWorker {
  readonly kind: WorkerKind;
  readonly id: string;
  readonly worker: Worker;
}

export interface KindStats {
  active: number;
  idle: number;
  total: number;
  peak: number;
  created: number;
  terminated: number;
  waiters: number;
}

export type PoolStats = Record<WorkerKind, KindStats>;

export class WorkerPoolSaturatedError extends Error {
  readonly kind: WorkerKind;
  constructor(kind: WorkerKind) {
    super(`worker_pool_saturated: no ${kind} worker available within timeout`);
    this.name = 'WorkerPoolSaturatedError';
    this.kind = kind;
  }
}
