/**
 * PerfSampler — periodic memory/latency sampling for the admin perf panel.
 *
 * Every tick (default 15s) it gathers:
 *   - main-process `process.memoryUsage()` + per-isolate `v8.getHeapStatistics()`
 *   - main event-loop delay percentiles (`monitorEventLoopDelay`)
 *   - the full Electron process tree via the injected `processMetricsProvider`
 *     (`app.getAppMetrics()` — null in web deploys)
 *   - per-worker-thread heap via the pools' `memStats()` RPC (best-effort)
 *   - the MemoryLedger subsystem snapshot
 *
 * The hot history remains an in-memory ring (240 samples ≈ 60 min), while each
 * completed sample is also appended to the crash-resilient JSONL journal so a
 * forced app close does not erase the evidence.
 */
import v8 from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getMemoryLedger, type LedgerEntry } from './memory-ledger.js';
import { recordPersistentPerfSample } from './persistent-diagnostics.js';
import type { WorkerMemStats } from '../../workers/perf-stats.js';

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
  sessionId: number;
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
    /** rss − heapTotal: native allocations (ONNX weights, SQLite, buffers). */
    nativeMB: number;
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

const RING_SIZE = 240;
const INTERVAL_MS = 15_000;
const mb = (n: number): number => Math.round((n / (1024 * 1024)) * 10) / 10;
const nsToMs = (n: number): number => Math.round(n / 1e5) / 10;

export class PerfSampler {
  private readonly history: PerfHistoryPoint[] = [];
  private lastSample: PerfSample | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private sampling: Promise<PerfSample> | null = null;

  constructor(private readonly sources: PerfSamplerSources) {}

  start(): void {
    if (this.timer) return;
    this.loop.enable();
    this.timer = setInterval(() => void this.sampleNow().catch(() => {}), INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.loop.disable();
  }

  /** Latest sample without forcing a new one (may be null right after boot). */
  getCurrent(): PerfSample | null {
    return this.lastSample;
  }

  getHistory(): PerfHistoryPoint[] {
    return this.history;
  }

  /** Take a fresh sample now (coalesces concurrent callers into one). */
  sampleNow(): Promise<PerfSample> {
    if (this.sampling) return this.sampling;
    this.sampling = this.collect().finally(() => {
      this.sampling = null;
    });
    return this.sampling;
  }

  private async collect(): Promise<PerfSample> {
    const mem = process.memoryUsage();
    const heap = v8.getHeapStatistics();

    let processes: PerfSample['processes'] = null;
    let totalWorkingSetMB: number | null = null;
    try {
      const metrics = this.sources.processMetricsProvider?.();
      if (metrics) {
        processes = metrics.map((m) => ({
          pid: m.pid,
          type: m.type,
          name: m.name ?? m.serviceName ?? '',
          // Electron reports workingSetSize in KILOBYTES.
          workingSetMB: Math.round(((m.memory?.workingSetSize ?? 0) / 1024) * 10) / 10,
          cpuPercent: Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10,
        }));
        totalWorkingSetMB = Math.round(processes.reduce((s, p) => s + p.workingSetMB, 0));
      }
    } catch {
      /* provider broken — keep null */
    }

    const [company, coder, indexer, ledger] = await Promise.all([
      this.sources.companyMemStats?.().catch(() => []) ?? Promise.resolve([]),
      this.sources.coderMemStats?.().catch(() => []) ?? Promise.resolve([]),
      this.sources.indexerMemStats?.().catch(() => null) ?? Promise.resolve(null),
      getMemoryLedger().snapshot(),
    ]);

    const sample: PerfSample = {
      at: Date.now(),
      main: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        rssMB: mb(mem.rss),
        heapUsedMB: mb(mem.heapUsed),
        heapTotalMB: mb(mem.heapTotal),
        heapLimitMB: mb(heap.heap_size_limit),
        externalMB: mb(mem.external),
        arrayBuffersMB: mb(mem.arrayBuffers),
        nativeMB: Math.max(0, mb(mem.rss - heap.total_heap_size)),
        loopP50Ms: nsToMs(this.loop.percentile(50)),
        loopP99Ms: nsToMs(this.loop.percentile(99)),
        loopMaxMs: nsToMs(this.loop.max),
      },
      processes,
      totalWorkingSetMB,
      workers: { company, coder, indexer },
      ledger,
    };
    this.loop.reset();

    this.lastSample = sample;
    this.history.push({
      at: sample.at,
      mainRssMB: sample.main.rssMB,
      mainHeapUsedMB: sample.main.heapUsedMB,
      totalWorkingSetMB,
      loopP99Ms: sample.main.loopP99Ms,
    });
    if (this.history.length > RING_SIZE) this.history.splice(0, this.history.length - RING_SIZE);
    recordPersistentPerfSample(sample);
    return sample;
  }
}

let singleton: PerfSampler | null = null;

export function startPerfSampler(sources: PerfSamplerSources): PerfSampler {
  if (!singleton) {
    singleton = new PerfSampler(sources);
    singleton.start();
  }
  return singleton;
}

export function getPerfSampler(): PerfSampler | null {
  return singleton;
}

export function stopPerfSampler(): void {
  singleton?.stop();
  singleton = null;
}
