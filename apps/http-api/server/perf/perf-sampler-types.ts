import type { WorkerMemStats } from '../../workers/perf-stats.js';
import type { LedgerEntry } from './memory-ledger.js';
/** Subset of Electron's ProcessMetric we consume (KB working set!). */
export interface ProcessMetricLike {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  cpu?: { percentCPUUsage?: number };
  memory?: { workingSetSize?: number; peakWorkingSetSize?: number };
}

export interface WorkerStatsRow {
  sessionId: string;
  stats: WorkerMemStats | null;
}

export interface PerfSample {
  at: number;
  main: {
    pid: number;
    uptimeSec: number;
    rssMB: number;
    heapUsedMB: number;
    heapTotalMB: number;
    heapLimitMB: number;
    externalMB: number;
    arrayBuffersMB: number;
    /**
     * Legacy wire field: RSS minus only the main isolate's allocated V8 heap.
     * It also contains worker heaps, code, stacks and allocator overhead, so it
     * must not be presented as purely native memory.
     */
    nativeMB: number;
    /** Explicit name for the legacy `nativeMB` calculation. */
    rssLessMainHeapMB?: number;
    /** Best-effort sums from worker `memStats()` responses available this tick. */
    knownWorkerHeapUsedMB?: number;
    knownWorkerHeapTotalMB?: number;
    /** RSS remainder after the main heap and known worker heaps are subtracted. */
    unattributedRssMB?: number;
    loopP50Ms: number;
    loopP99Ms: number;
    loopMaxMs: number;
  };
  /** Electron process tree (workingSetMB per child); null outside Electron. */
  processes:
    | Array<{ pid: number; type: string; name: string; workingSetMB: number; cpuPercent: number }>
    | null;
  totalWorkingSetMB: number | null;
  workers: {
    company: WorkerStatsRow[];
    coder: WorkerStatsRow[];
    indexer: WorkerMemStats | null;
  };
  ledger: LedgerEntry[];
}

/** Compact history point for the sparkline. */
export interface PerfHistoryPoint {
  at: number;
  mainRssMB: number;
  mainHeapUsedMB: number;
  totalWorkingSetMB: number | null;
  loopP99Ms: number;
}

export interface PerfSamplerSources {
  /** May return null while the Electron main hasn't injected the provider yet. */
  processMetricsProvider?: () => ProcessMetricLike[] | null;
  companyMemStats?: () => Promise<WorkerStatsRow[]>;
  coderMemStats?: () => Promise<WorkerStatsRow[]>;
  indexerMemStats?: () => Promise<WorkerMemStats | null>;
}
