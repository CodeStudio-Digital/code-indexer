import { resolve } from 'node:path';
import type { PerfSample } from './perf-sampler-types.js';
import type { PersistedFreezeEvent } from './persistent-diagnostics-types.js';
import type { PersistedRendererFreeze } from './persistent-diagnostics-types.js';
import type { PersistedRendererFreezeReport } from './persistent-diagnostics-types.js';
import type { PersistedPerfRunSummary } from './persistent-diagnostics-types.js';
import type { PersistedPerfRunDetail } from './persistent-diagnostics-types.js';
import type { PersistentPerfDiagnosticsOptions } from './persistent-diagnostics-types.js';
import { PersistentPerfDiagnostics } from './persistent-diagnostics-writer.js';
export { PersistentPerfDiagnostics } from './persistent-diagnostics-writer.js';
export type { PersistedRendererFreeze, PersistedRendererFreezeReport } from './persistent-diagnostics-types.js';

let singleton: PersistentPerfDiagnostics | null = null;

export function startPersistentPerfDiagnostics(options: PersistentPerfDiagnosticsOptions = {}): PersistentPerfDiagnostics | null {
  if (singleton) return singleton;
  try {
    singleton = new PersistentPerfDiagnostics(options);
    return singleton;
  } catch (error) {
    console.warn(`[perf-journal] could not start: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function stopPersistentPerfDiagnostics(reason = 'graceful'): Promise<void> {
  const active = singleton;
  singleton = null;
  await active?.close(reason);
}

export function recordPersistentPerfSample(sample: PerfSample): void {
  singleton?.recordSample(sample);
}

export function recordPersistentFreeze(event: PersistedFreezeEvent): void {
  singleton?.recordFreeze(event);
}

export function recordPersistentSlowCall(channel: string, durationMs: number, at?: number): void {
  singleton?.recordSlowCall(channel, durationMs, at);
}

function recordPersistentRendererFreeze(event: PersistedRendererFreeze, runId?: string): Promise<boolean> {
  return singleton?.recordRendererFreeze(event, runId) ?? Promise.resolve(false);
}

export function recordPersistentRendererFreezes(
  events: PersistedRendererFreeze[],
  runId?: string,
  report?: PersistedRendererFreezeReport,
): Promise<number> {
  return singleton?.recordRendererFreezes(events, runId, report) ?? Promise.resolve(0);
}

export function listPersistentPerfRuns(): Promise<PersistedPerfRunSummary[]> {
  return singleton?.listRunsAsync() ?? Promise.resolve([]);
}

export async function readPersistentPerfRun(runId: string): Promise<PersistedPerfRunDetail | null> {
  return singleton ? singleton.readRunAsync(runId) : null;
}

export function currentPersistentPerfRun(): PersistedPerfRunSummary | null {
  return singleton?.currentRun() ?? null;
}
