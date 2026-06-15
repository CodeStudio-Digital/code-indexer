/**
 * Module-level binding for the ApiClientStore used by the `api_*` tools.
 * worker_threads don't share module state, so this is wired in server.ts
 * (main) AND each worker boot (coder/company). A null binding makes the tools
 * return a clear "not wired" message instead of throwing.
 */
import type { ApiClientStore } from '@mcp/store/api-client-store.js';

let store: ApiClientStore | null = null;

export function setApiClientStore(s: ApiClientStore | null): void {
  store = s;
}

export function getApiClientStore(): ApiClientStore | null {
  return store;
}
