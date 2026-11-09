import { AsyncLocalStorage } from 'node:async_hooks';
import type { QueryResult } from './types.js';

type Stage = 'queueMs' | 'acquireMs' | 'executeFetchMs';
const scope = new AsyncLocalStorage<Partial<Record<Stage, number>>>();

/** Only durations cross this boundary. SQL, parameters, endpoints and rows do not. */
export function recordDatabaseStage(stage: Stage, startedAt: number): void {
  const state = scope.getStore();
  if (state) state[stage] = (state[stage] ?? 0) + Math.max(0, performance.now() - startedAt);
}
export async function timedDatabaseStage<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await operation(); } finally { recordDatabaseStage(stage, started); }
}
export function withDatabaseTimings(operation: () => Promise<QueryResult>): Promise<QueryResult> {
  return scope.run({}, async (): Promise<QueryResult> => {
    const started = performance.now();
    const result = await operation();
    return { ...result, timings: { version: 1, totalMs: performance.now() - started, ...scope.getStore(),
      // Pool acquisition and streamed server/fetch are combined deliberately.
      // Transport serialization and paint belong to their respective owners.
      unmeasured: ['connectOnlyMs', 'serverOnlyMs', 'serializationMs', 'uiMs'] } };
  });
}
