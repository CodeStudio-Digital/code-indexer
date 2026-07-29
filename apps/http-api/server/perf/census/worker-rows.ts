/**
 * Worker-thread rows for the task manager.
 *
 * These are read from the perf sampler's most recent BACKGROUND sample rather
 * than a fresh `memStats()` fan-out. That RPC round trip (three pools, 2s
 * timeout each) is precisely what made `/api/admin/perf/current` park the main
 * event loop on every poll, and this route exists to be pollable at 1-2s.
 */
import type { PerfSample } from '../perf-sampler.js';
import type { WorkerRowInput } from './task-rows.js';

export function workerRowsFromSample(sample: PerfSample | null): WorkerRowInput[] {
  if (!sample) return [];
  const rows: WorkerRowInput[] = [];
  for (const worker of sample.workers.company) {
    if (worker.stats) {
      rows.push({
        id: `company#${worker.sessionId}`,
        label: `company #${worker.sessionId}`,
        heapUsedMB: worker.stats.heapUsedMB,
      });
    }
  }
  for (const worker of sample.workers.coder) {
    if (worker.stats) {
      rows.push({
        id: `coder#${worker.sessionId}`,
        label: `coder #${worker.sessionId}`,
        heapUsedMB: worker.stats.heapUsedMB,
      });
    }
  }
  if (sample.workers.indexer) {
    rows.push({ id: 'indexer', label: 'indexer', heapUsedMB: sample.workers.indexer.heapUsedMB });
  }
  return rows;
}
