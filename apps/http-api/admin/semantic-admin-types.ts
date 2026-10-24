import { SemanticStore, type EmbeddingTarget, type RerankerTarget, type SemanticPurpose } from '@mcp/store/semantic-store.js';
import type { LocalVectorNamespaceStatus } from '@mcp/store/local-vector-router.js';
import type { probeEmbeddingTarget, probeRerankerTarget } from '@mcp/indexer/search/semantic-targets.js';

export interface SemanticAdminRuntime {
  store: SemanticStore;
  reindex(purpose: SemanticPurpose): Promise<unknown>;
  cleanupUnusedVectors(): Promise<unknown>;
  namespaceStatus(namespace: string): LocalVectorNamespaceStatus;
  /** Worker-backed in production. Requiring these callbacks prevents an
   * omitted composition hook from loading ONNX in the HTTP/main process. */
  probeEmbeddingTarget(target: EmbeddingTarget): ReturnType<typeof probeEmbeddingTarget>;
  probeRerankerTarget(target: RerankerTarget): ReturnType<typeof probeRerankerTarget>;
  /** Metadata-only worker RPC. It must never instantiate ONNX in the HTTP or
   * Electron main process. */
  rerankerDiagnostics?(purpose: SemanticPurpose): Promise<unknown> | unknown;
}

export interface SemanticRerankerStatus {
  target_kind: RerankerTarget['kind'] | 'missing';
  diagnostics: Record<string, unknown> | null;
  error: string | null;
}
