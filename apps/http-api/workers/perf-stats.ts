/**
 * Worker-side perf stats handler — registered by every worker_thread
 * entry (company-worker, coder-worker, indexer-worker).
 *
 * Why per-worker: `process.memoryUsage()` inside a worker reports the
 * WHOLE process (RSS is shared across threads), but `v8.getHeapStatistics()`
 * is per-isolate — each worker_thread owns its own V8 isolate, so this is
 * the only accurate way to attribute heap to a specific worker.
 *
 * The main-thread perf sampler calls `perf.memStats` over the existing
 * MessageBridge with a short timeout (best-effort; a busy worker that
 * can't answer in time just shows up as "no data" in the panel).
 */
import v8 from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface WorkerMemStats {
  /** Per-isolate V8 heap, MB. */
  heapUsedMB: number;
  heapTotalMB: number;
  heapLimitMB: number;
  /** ArrayBuffers + external strings attributed to this isolate, MB. */
  externalMB: number;
  /** Native allocations tracked by V8 (malloc'd), MB. */
  mallocedMB: number;
  /** Event-loop delay percentiles since the previous sample, ms. */
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
}

interface BridgeLike {
  handle(method: string, fn: (payload: unknown) => unknown): () => void;
}

export function buildMemStats(loop?: ReturnType<typeof monitorEventLoopDelay>): WorkerMemStats {
  const s = v8.getHeapStatistics();
  const mb = (n: number): number => Math.round((n / (1024 * 1024)) * 10) / 10;
  const ns = (n: number): number => Math.round(n / 1e5) / 10; // ns → ms, 1 decimal
  const stats: WorkerMemStats = {
    heapUsedMB: mb(s.used_heap_size),
    heapTotalMB: mb(s.total_heap_size),
    heapLimitMB: mb(s.heap_size_limit),
    externalMB: mb(s.external_memory),
    mallocedMB: mb(s.malloced_memory),
    loopP50Ms: loop ? ns(loop.percentile(50)) : 0,
    loopP99Ms: loop ? ns(loop.percentile(99)) : 0,
    loopMaxMs: loop ? ns(loop.max) : 0,
  };
  loop?.reset();
  return stats;
}

/**
 * Register the perf RPC handlers on a worker's bridge:
 *   `perf.memStats`   — per-isolate heap + event-loop lag (cheap, sampled)
 *   `perf.cpuProfile` — on-demand V8 CPU profile of THIS worker's isolate
 *                       (node:inspector profiles the calling thread only)
 */
export function registerPerfStatsHandler(bridge: BridgeLike): () => void {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const offMem = bridge.handle('perf.memStats', () => buildMemStats(loop));
  const offCpu = bridge.handle('perf.cpuProfile', async (payload) => {
    const { durationMs } = (payload ?? {}) as { durationMs?: number };
    const { captureCpuProfile } = await import('../server/perf/cpu-profile.js');
    return captureCpuProfile(Math.min(30_000, Math.max(5_000, durationMs ?? 10_000)));
  });
  return () => {
    offMem();
    offCpu();
  };
}
