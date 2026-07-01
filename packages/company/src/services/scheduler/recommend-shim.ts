/**
 * Worker-side recommender shim (Phase 2 — "brain → hands").
 *
 * The role recommender is embedding-backed (two-tower scorer) and its model +
 * `roleEmbeddingStore` live ONCE on the main thread. `worker_threads` don't
 * share module state, so the company-worker can't call it directly. This module
 * holds a process-global function that the worker boot wires to an RPC shim
 * (`bridge.request('recommend', …)` → main-side handler in WorkerOrchestratorPool),
 * exactly like `setGlobalDocSearch` does for `rag_search_docs`.
 *
 * The CompanyScheduler reads it via `getGlobalCompanyRecommend()` and tolerates
 * null (returns no recommendation → the scheduler simply skips that card).
 */

export interface CompanyRecommendInput {
  companySessionId: number;
  /** The card's title + description — what we want a role for. */
  taskText: string;
  /** How many ranked roles to return (default 1). */
  k?: number;
}

export interface CompanyRecommendation {
  role: string;
  /** 'spawn' (new agent) vs 'reuse' (an idle run of this role exists). */
  kind: string;
  score: number;
}

export interface CompanyRecommendResult {
  recommendations: CompanyRecommendation[];
}

export type CompanyRecommendFn = (
  input: CompanyRecommendInput,
) => Promise<CompanyRecommendResult>;

let globalRecommend: CompanyRecommendFn | null = null;

export function setGlobalCompanyRecommend(fn: CompanyRecommendFn | null): void {
  globalRecommend = fn;
}

export function getGlobalCompanyRecommend(): CompanyRecommendFn | null {
  return globalRecommend;
}
