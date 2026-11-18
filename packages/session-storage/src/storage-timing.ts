import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { threadId } from 'node:worker_threads';

export interface StorageTiming {
  sessionId: string;
  operationId: string;
  startedAt: string;
  durationMs: number;
  eventLoopActiveMs: number;
  eventLoopIdleMs: number;
  failed: boolean;
  stages: Array<{ name: string; count: number; totalMs: number; maxMs: number; slowestFile?: string }>;
}

interface Trace {
  stages: Map<string, StorageTiming['stages'][number]>;
}
const traces = new AsyncLocalStorage<Trace>();
const recent: StorageTiming[] = [];
const exportQueue: StorageTiming[] = [];
let exporting = false;
let droppedExports = 0;

/** Bounded diagnostics, independent of the session writer and its durability queue. */
export function storageTimingSnapshot(): readonly StorageTiming[] { return recent.slice(); }

export function hasStorageTrace(): boolean { return traces.getStore() !== undefined; }

export function recordStorageElapsed(name: string, started: number, path?: string): void {
  const trace = traces.getStore();
  if (!trace) return;
  let stage = trace.stages.get(name);
  if (!stage) {
    if (trace.stages.size >= 64) return;
    stage = { name, count: 0, totalMs: 0, maxMs: 0 };
    trace.stages.set(name, stage);
  }
  const elapsed = performance.now() - started;
  stage.count++;
  stage.totalMs += elapsed;
  if (elapsed > stage.maxMs) {
    stage.maxMs = elapsed;
    if (path) stage.slowestFile = basename(path);
  }
}

export async function measureStorage<T>(name: string, task: () => Promise<T>, path?: string): Promise<T> {
  if (!traces.getStore()) return task();
  const start = performance.now();
  try { return await task(); } finally { recordStorageElapsed(name, start, path); }
}

export function measureStorageSync<T>(name: string, task: () => T, path?: string): T {
  if (!traces.getStore()) return task();
  const start = performance.now();
  try { return task(); } finally { recordStorageElapsed(name, start, path); }
}

function publish(timing: StorageTiming): void {
  recent.push(timing);
  if (recent.length > 128) recent.shift();
  const destination = process.env.CODESTUDIO_STORAGE_TRACE_FILE;
  if (!destination) return;
  if (exportQueue.length >= 128) { droppedExports++; return; }
  exportQueue.push(timing);
  if (exporting) return;
  exporting = true;
  // Formatting/export never holds the transcript promise. A slow/full disk
  // drops diagnostic samples instead of building an unbounded second journal.
  setImmediate(() => {
    void (async () => {
      try {
        while (exportQueue.length) {
          const batch = exportQueue.splice(0, 32);
          const dropped = droppedExports;
          droppedExports = 0;
          await appendFile(`${destination}-${process.pid}-${threadId}.jsonl`,
            batch.map(row => JSON.stringify({ ...row, droppedExports: dropped })).join('\n') + '\n');
        }
      } catch { exportQueue.length = 0; }
      finally { exporting = false; }
    })();
  }).unref();
}

export async function traceStorageOperation<T>(
  identity: Pick<StorageTiming, 'sessionId' | 'operationId'>,
  task: () => Promise<T>,
): Promise<T> {
  if (traces.getStore()) return task();
  const trace: Trace = { stages: new Map() };
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const loop = performance.eventLoopUtilization();
  let failed = false;
  try { return await traces.run(trace, task); }
  catch (error) { failed = true; throw error; }
  finally {
    const utilization = performance.eventLoopUtilization(loop);
    publish({ ...identity, startedAt, durationMs: performance.now() - start,
      eventLoopActiveMs: utilization.active, eventLoopIdleMs: utilization.idle,
      failed, stages: [...trace.stages.values()] });
  }
}
