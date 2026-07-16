/**
 * Shared reranker contract types.
 *
 * Extracted from reranker.ts so concrete services (e.g. ./local-reranker.ts)
 * can implement the interface WITHOUT importing the factory module — which
 * imports them back, forming a (type-only but lint-flagged) import cycle.
 * reranker.ts re-exports these for backward compatibility.
 */

export interface RerankCandidate {
  /** Unique identifier (e.g., "file:42" or "symbol:78") */
  id: string;
  /** Text content to score against the query */
  text: string;
  /** Original score from RRF (preserved for tie-breaking) */
  originalScore: number;
}

export interface RerankResult {
  id: string;
  score: number;
  originalScore: number;
}

export interface RerankRequestOptions {
  /** Stable key for latest-wins interactive queries (for example one Search
   * Everywhere box). Implementations may discard queued older work sharing
   * the key; an inference already running is allowed to finish. */
  supersessionKey?: string;
  signal?: AbortSignal;
}

export interface RerankerService {
  readonly name: string;
  /**
   * Synchronous revision used by query-result caches. It should change when
   * the effective target, model, or provider credentials change.
   *
   * Optional for compatibility with standalone/legacy rerankers and must not
   * perform inference or network I/O.
   */
  cacheRevision?(): string;
  /** Best-effort runtime state for semantic status UI. Must never trigger a
   * model load merely to render diagnostics. */
  diagnostics?(): unknown | Promise<unknown>;
  /** Number of fused candidates the caller should retain before invoking
   * rerank. Worker-backed adaptive policies can request their maximum safe
   * pool and trim it after inspecting live hardware. */
  candidatePoolSize?(topK: number): number;
  /**
   * Re-rank candidates by relevance to the query.
   * Returns candidates sorted by score descending.
   */
  rerank(
    query: string,
    candidates: RerankCandidate[],
    topK?: number,
    options?: RerankRequestOptions,
  ): Promise<RerankResult[]>;
  /**
   * Release process-held resources (local ONNX sessions). Optional —
   * network rerankers and the Null passthrough have nothing to free.
   * Implementations must tolerate further calls after dispose.
   */
  dispose?(): Promise<void>;
}
