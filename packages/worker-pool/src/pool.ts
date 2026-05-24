/**
 * Dynamic worker pool. Each `WorkerKind` (coder, lsp, index) has an
 * independent bucket with its own min/max + auto-scale.
 *
 * Semantics:
 *   - `acquire(kind)` returns an idle worker if one exists. Otherwise:
 *       - if `total < max`, spawn a new one and return it
 *       - else, queue the request and resolve when one frees up
 *         (with `acquireTimeoutMs` as a hard ceiling)
 *   - `release(worker)` returns it to the idle list. After `idleTimeoutMs`
 *     it's terminated, but only if the bucket still has ≥ min workers.
 *     The minimum is therefore "pre-warmed" — first acquire of a fresh
 *     kind spawns the min and they stay alive across acquire/release
 *     cycles until idle timeout exceeds reuse rate.
 *
 * The pool is the supervisor — consumers don't terminate workers
 * directly. If a worker emits 'exit' unexpectedly, the pool drops it
 * from its tracking and the next acquire spawns a replacement (or one
 * of the queued waiters gets it).
 */

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  type KindConfig,
  type KindStats,
  type PoolStats,
  type PooledWorker,
  type WorkerKind,
  WorkerPoolSaturatedError,
} from './types.js';

const KINDS: WorkerKind[] = ['coder', 'lsp', 'index'];

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

function defaultMax(): number {
  return Math.min(os.cpus().length * 2, 16);
}

interface IdleEntry {
  worker: PooledWorker;
  idleTimer: NodeJS.Timeout;
}

interface Waiter {
  resolve: (worker: PooledWorker) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Bucket {
  config: Required<Omit<KindConfig, 'spec'>> & { spec: KindConfig['spec'] };
  /** Workers currently checked out via acquire(). */
  busy: Set<PooledWorker>;
  /** Workers waiting for the next acquire. */
  idle: IdleEntry[];
  /** Requests blocked because the pool is at max. */
  waiters: Waiter[];
  /** Counters for stats(). */
  created: number;
  terminated: number;
  peak: number;
}

export class WorkerPool {
  private readonly buckets = new Map<WorkerKind, Bucket>();
  private disposed = false;

  constructor(configs: Partial<Record<WorkerKind, KindConfig>>) {
    for (const kind of KINDS) {
      const provided = configs[kind];
      if (!provided) continue;
      const max = provided.max ?? defaultMax();
      const min = Math.min(provided.min ?? 1, max);
      const idleTimeoutMs = provided.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      const acquireTimeoutMs = provided.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
      this.buckets.set(kind, {
        config: { spec: provided.spec, min, max, idleTimeoutMs, acquireTimeoutMs },
        busy: new Set(),
        idle: [],
        waiters: [],
        created: 0,
        terminated: 0,
        peak: 0,
      });
      // Pre-warm: spawn `min` workers up front so the first acquire is
      // instant. Fire-and-forget — failures degrade to lazy spawn on
      // first acquire.
      for (let i = 0; i < min; i++) {
        try {
          const w = this.spawn(kind);
          this.pushIdle(kind, w);
        } catch (err) {
          // Pre-warm failure is non-fatal; record but don't block.
          console.warn(`[worker-pool] pre-warm ${kind} failed:`, err);
        }
      }
    }
  }

  acquire(kind: WorkerKind): Promise<PooledWorker> {
    if (this.disposed) return Promise.reject(new Error('worker pool disposed'));
    const bucket = this.requireBucket(kind);

    // (1) Reuse an idle worker if available.
    const idle = bucket.idle.pop();
    if (idle) {
      clearTimeout(idle.idleTimer);
      bucket.busy.add(idle.worker);
      bucket.peak = Math.max(bucket.peak, bucket.busy.size);
      return Promise.resolve(idle.worker);
    }

    // (2) Spawn fresh if under max.
    if (bucket.busy.size < bucket.config.max) {
      const worker = this.spawn(kind);
      bucket.busy.add(worker);
      bucket.peak = Math.max(bucket.peak, bucket.busy.size);
      return Promise.resolve(worker);
    }

    // (3) Pool saturated — queue the request with a timeout.
    return new Promise<PooledWorker>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = bucket.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) bucket.waiters.splice(idx, 1);
        reject(new WorkerPoolSaturatedError(kind));
      }, bucket.config.acquireTimeoutMs);
      bucket.waiters.push({ resolve, reject, timer });
    });
  }

  release(worker: PooledWorker): void {
    if (this.disposed) {
      worker.worker.terminate().catch(() => undefined);
      return;
    }
    const bucket = this.requireBucket(worker.kind);
    if (!bucket.busy.delete(worker)) {
      // Already released or unknown — terminate defensively.
      worker.worker.terminate().catch(() => undefined);
      return;
    }
    // (1) If a waiter is queued, hand the worker off directly without
    // bouncing through the idle list.
    const waiter = bucket.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      bucket.busy.add(worker);
      bucket.peak = Math.max(bucket.peak, bucket.busy.size);
      waiter.resolve(worker);
      return;
    }
    // (2) No waiters — park in idle list, schedule idle timeout.
    this.pushIdle(worker.kind, worker);
  }

  stats(): PoolStats {
    const out: PoolStats = {} as PoolStats;
    for (const kind of KINDS) {
      const bucket = this.buckets.get(kind);
      if (!bucket) {
        out[kind] = { active: 0, idle: 0, total: 0, peak: 0, created: 0, terminated: 0, waiters: 0 };
        continue;
      }
      out[kind] = this.snapshot(bucket);
    }
    return out;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const all: Promise<unknown>[] = [];
    for (const bucket of this.buckets.values()) {
      for (const entry of bucket.idle) {
        clearTimeout(entry.idleTimer);
        all.push(entry.worker.worker.terminate().catch(() => undefined));
      }
      for (const w of bucket.busy) {
        all.push(w.worker.terminate().catch(() => undefined));
      }
      for (const waiter of bucket.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('worker pool disposed'));
      }
      bucket.idle = [];
      bucket.busy.clear();
      bucket.waiters = [];
    }
    await Promise.allSettled(all);
  }

  // ─── Internals ───────────────────────────────────────────

  private requireBucket(kind: WorkerKind): Bucket {
    const bucket = this.buckets.get(kind);
    if (!bucket) {
      throw new Error(`worker pool: kind "${kind}" not configured`);
    }
    return bucket;
  }

  private spawn(kind: WorkerKind): PooledWorker {
    const bucket = this.requireBucket(kind);
    const { spec } = bucket.config;
    const worker = new Worker(spec.file, {
      execArgv: spec.execArgv,
      workerData: spec.initData,
    });
    bucket.created += 1;
    const pooled: PooledWorker = { kind, id: randomUUID(), worker };

    // Unexpected exit: drop from whichever set holds the worker so the
    // counters stay honest. Next acquire will spawn fresh.
    worker.once('exit', () => {
      bucket.busy.delete(pooled);
      const idx = bucket.idle.findIndex((e) => e.worker === pooled);
      if (idx >= 0) {
        clearTimeout(bucket.idle[idx].idleTimer);
        bucket.idle.splice(idx, 1);
      }
      bucket.terminated += 1;
    });
    return pooled;
  }

  private pushIdle(kind: WorkerKind, worker: PooledWorker): void {
    const bucket = this.requireBucket(kind);
    const idleTimer = setTimeout(() => {
      // Only terminate if we'd still have ≥ min workers after.
      const totalAfter = bucket.busy.size + bucket.idle.length - 1;
      if (totalAfter < bucket.config.min) {
        // Keep alive; reschedule the timer so we revisit later.
        this.pushIdle(kind, worker);
        return;
      }
      const idx = bucket.idle.findIndex((e) => e.worker === worker);
      if (idx >= 0) {
        bucket.idle.splice(idx, 1);
      }
      worker.worker.terminate().catch(() => undefined);
    }, bucket.config.idleTimeoutMs);
    idleTimer.unref?.();
    bucket.idle.push({ worker, idleTimer });
  }

  private snapshot(bucket: Bucket): KindStats {
    return {
      active: bucket.busy.size,
      idle: bucket.idle.length,
      total: bucket.busy.size + bucket.idle.length,
      peak: bucket.peak,
      created: bucket.created,
      terminated: bucket.terminated,
      waiters: bucket.waiters.length,
    };
  }
}
