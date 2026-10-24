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
export function assertDatabaseDispatch(options: Pick<RunQueryOptions, 'signal' | 'beforeDispatch'>): void {
  const scope = current.getStore();
  scope?.signal.throwIfAborted();
  scope?.assertDispatch();
  options.signal?.throwIfAborted();
  options.beforeDispatch?.();
}
