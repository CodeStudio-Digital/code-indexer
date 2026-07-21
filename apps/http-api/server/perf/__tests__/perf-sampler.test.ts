import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerMemStats } from '../../../workers/perf-stats.js';
import { PerfSampler } from '../perf-sampler.js';

const samplers: PerfSampler[] = [];

function workerStats(heapUsedMB: number, heapTotalMB: number): WorkerMemStats {
  return {
    heapUsedMB,
    heapTotalMB,
    heapLimitMB: 4_096,
    externalMB: 1,
    mallocedMB: 1,
    loopP50Ms: 1,
    loopP99Ms: 2,
    loopMaxMs: 3,
  };
}

afterEach(() => {
  for (const sampler of samplers.splice(0)) sampler.stop();
});

describe('PerfSampler memory attribution', () => {
  it('separates known worker heaps from the RSS remainder while preserving nativeMB', async () => {
    const sampler = new PerfSampler({
      companyMemStats: async () => [
        { sessionId: 1, stats: workerStats(10, 20) },
        { sessionId: 2, stats: null },
      ],
      coderMemStats: async () => [{ sessionId: 3, stats: workerStats(30, 40) }],
      indexerMemStats: async () => workerStats(5, 10),
    });
    samplers.push(sampler);

    const sample = await sampler.sampleNow();

    expect(sample.main.knownWorkerHeapUsedMB).toBe(45);
    expect(sample.main.knownWorkerHeapTotalMB).toBe(70);
    expect(sample.main.rssLessMainHeapMB).toBe(sample.main.nativeMB);
    expect(sample.main.unattributedRssMB).toBe(
      Math.max(0, Math.round((sample.main.nativeMB - 70) * 10) / 10),
    );
  });
});
