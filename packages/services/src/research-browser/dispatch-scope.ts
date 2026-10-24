import { AsyncLocalStorage } from 'node:async_hooks';
import type { HostUiDispatchScope } from '@mcp/shared/host-ui-dispatch.js';

const current = new AsyncLocalStorage<HostUiDispatchScope>();
export function runBrowserDispatch<T>(scope: HostUiDispatchScope, operation: () => T): T {
  return current.run(scope, operation);
}
export function assertBrowserDispatch(): void {
  const scope = current.getStore();
  scope?.signal.throwIfAborted();
  scope?.assertDispatch();
}
export function browserLifetimeGuard(): () => void {
  const scope = current.getStore();
  return () => {
    scope?.signal.throwIfAborted();
    (scope?.assertLifetime ?? scope?.assertDispatch)?.();
  };
}
