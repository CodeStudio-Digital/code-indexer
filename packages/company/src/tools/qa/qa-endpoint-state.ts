import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
// ─── Module-level binding for the env store (used to surface the QA
// preview-URL family alongside the wsEndpoint). Mirrors the existing
// `setQaTestRunStore` pattern. Optional — when null we just omit the
// PLAYWRIGHT_BASE_URL_* lines from the reply, never error.

let envStore: CompanySessionEnvStore | null = null;

export function setQaEndpointEnvStore(store: CompanySessionEnvStore | null): void {
  envStore = store;
}

/**
 * B7 — read-only accessor for the bound env store. `qa-preflight.ts`
 * reuses the same boot wiring (both server.ts and company-worker call
 * `setQaEndpointEnvStore`) instead of introducing a second binding.
 */
export function getQaEndpointEnvStore(): CompanySessionEnvStore | null {
  return envStore;
}
