import type { RunQueryOptions } from './types.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const current = new AsyncLocalStorage<{ signal: AbortSignal; assertDispatch(): void }>();
export function runDatabaseDispatch<T>(scope: { signal: AbortSignal; assertDispatch(): void }, operation: () => T): T {
  return current.run(scope, operation);
}
export function databaseDispatchSignal(signal?: AbortSignal): AbortSignal | undefined {
  const inherited = current.getStore()?.signal;
  return inherited && signal ? AbortSignal.any([inherited, signal]) : inherited ?? signal;
}

/** A connection/setup await is not permission to dispatch a later statement. */
export function assertDatabaseDispatch(options: Pick<RunQueryOptions, 'signal' | 'beforeDispatch' | 'deadlineAtEpochMs'>): void {
  const scope = current.getStore();
  scope?.signal.throwIfAborted();
  scope?.assertDispatch();
  options.signal?.throwIfAborted();
  if (options.deadlineAtEpochMs !== undefined && Date.now() >= options.deadlineAtEpochMs) throw new Error('Database invocation deadline expired before dispatch');
  options.beforeDispatch?.();
}

/** Convert once at the public driver boundary; nested statements use its balance. */
export async function withDatabaseDeadline<T>(options: RunQueryOptions, work: (effective: RunQueryOptions) => Promise<T>): Promise<T> {
  const deadlineAtEpochMs = Math.min(options.deadlineAtEpochMs ?? Infinity,
    options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs);
  if (!Number.isFinite(deadlineAtEpochMs)) return work(options);
  const timeoutMs = Math.max(1, deadlineAtEpochMs - Date.now());
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error('Database invocation deadline expired')), timeoutMs);
  timer.unref();
  try { assertDatabaseDispatch({ ...options, signal, deadlineAtEpochMs }); return await work({ ...options, signal, timeoutMs, deadlineAtEpochMs }); }
  finally { clearTimeout(timer); }
}
