import { AsyncLocalStorage } from 'node:async_hooks';
import type { PreviewDispatchScope } from '@mcp/services/preview/contracts.js';

const dispatch = new AsyncLocalStorage<PreviewDispatchScope>();

export function runPreviewDispatch<T>(scope: PreviewDispatchScope, fn: () => T): T {
  return dispatch.run(scope, fn);
}

/** No await may separate this check from the corresponding Electron effect. */
export function assertPreviewDispatch(): void {
  const scope = dispatch.getStore();
  scope?.signal.throwIfAborted();
  scope?.assertDispatch();
}

export function previewDispatchRunner() { return dispatch.getStore()?.runner; }
