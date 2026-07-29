/**
 * Polling hook for the admin perf panel.
 *
 * Polls `GET /api/admin/perf/current` every 10s while the tab is visible
 * (the endpoint serves a ≤2.5s-cached backend sample) and `/history` every 30s
 * for the sparkline. Also collects renderer-local metrics that only this
 * process can see: Chromium's `performance.memory` and the Monaco model
 * registry (count + buffered chars).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBaseUrl } from '../../../lib/api-client.js';
import { getModelStats } from '../../workspace/editor/editor-models.js';

export interface WorkerMemStats {
  heapUsedMB: number;
  heapTotalMB: number;
  heapLimitMB: number;
  externalMB: number;
  mallocedMB: number;
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
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
    nativeMB: number;
    rssLessMainHeapMB?: number;
    knownWorkerHeapUsedMB?: number;
    knownWorkerHeapTotalMB?: number;
    unattributedRssMB?: number;
    loopP50Ms: number;
    loopP99Ms: number;
    loopMaxMs: number;
  };
  processes:
    | Array<{ pid: number; type: string; name: string; workingSetMB: number; cpuPercent: number }>
    | null;
  totalWorkingSetMB: number | null;
  workers: {
    company: Array<{ sessionId: string; stats: WorkerMemStats | null }>;
    coder: Array<{ sessionId: string; stats: WorkerMemStats | null }>;
    indexer: WorkerMemStats | null;
  };
  ledger: Array<{ name: string; count: number; bytes?: number; detail?: string }>;
}

export interface PerfHistoryPoint {
  at: number;
  mainRssMB: number;
  mainHeapUsedMB: number;
  totalWorkingSetMB: number | null;
  loopP99Ms: number;
}

export interface RendererStats {
  jsHeapUsedMB: number | null;
  jsHeapTotalMB: number | null;
  monacoModels: number;
  monacoChars: number;
  viewStates: number;
}

function readRendererStats(): RendererStats {
  const perfMem = (performance as unknown as {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
  }).memory;
  const mb = (n: number): number => Math.round((n / (1024 * 1024)) * 10) / 10;
  let monaco = { models: 0, totalChars: 0, viewStates: 0 };
  try {
    monaco = getModelStats();
  } catch {
    /* workspace not mounted yet */
  }
  return {
    jsHeapUsedMB: perfMem ? mb(perfMem.usedJSHeapSize) : null,
    jsHeapTotalMB: perfMem ? mb(perfMem.totalJSHeapSize) : null,
    monacoModels: monaco.models,
    monacoChars: monaco.totalChars,
    viewStates: monaco.viewStates,
  };
}

// 10s (was 5s): a fresh sample fans out to 3 worker-pool RPCs; 10s is still
// responsive for a diagnostics panel and halves the panel's own footprint
// (the backend also caches the sample for ~2.5s).
const CURRENT_MS = 10_000;
const HISTORY_MS = 30_000;

export function usePerfMonitor(): {
  sample: PerfSample | null;
  history: PerfHistoryPoint[];
  renderer: RendererStats | null;
  error: string | null;
  refresh: () => void;
} {
  const [sample, setSample] = useState<PerfSample | null>(null);
  const [history, setHistory] = useState<PerfHistoryPoint[]>([]);
  const [renderer, setRenderer] = useState<RendererStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastHistoryAt = useRef(0);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const r = await fetch(`${apiBaseUrl()}/api/admin/perf/current`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setSample((await r.json()) as PerfSample);
        setRenderer(readRendererStats());
        setError(null);
        if (Date.now() - lastHistoryAt.current > HISTORY_MS) {
          lastHistoryAt.current = Date.now();
          const h = await fetch(`${apiBaseUrl()}/api/admin/perf/history`);
          if (h.ok) setHistory(((await h.json()) as { points: PerfHistoryPoint[] }).points);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, CURRENT_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { sample, history, renderer, error, refresh };
}
