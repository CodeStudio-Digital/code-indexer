
/** Independent build domains. They may share the same configured target and
 * worker session, but never share generation locks or rollout state. */
import type DatabaseConstructor from 'better-sqlite3';
export type DB = InstanceType<typeof DatabaseConstructor>;

export type SemanticPurpose = 'code' | 'docs' | 'memory';

export type SemanticCapability = 'embedding' | 'rerank';

export type MemoryNamespaceSource =
  | { scope: 'user'; projectId: 0 }
  | { scope: 'project'; projectId: number };

/** Dtypes accepted by the managed transformers.js ONNX runtime. `q8` is the
 * local default: it keeps the desktop memory envelope predictable while the
 * complete target remains pinned in the generation fingerprint. */
export type SemanticOnnxDtype = 'q8' | 'q4' | 'fp16' | 'fp32';

export type EmbeddingTarget =
  | {
      kind: 'onnx';
      model: string;
      revision?: string;
      cacheDir?: string;
      dtype?: SemanticOnnxDtype;
      pooling: 'mean' | 'cls';
      normalize: boolean;
      queryTemplate: string;
      documentTemplate: string;
      maxTokens?: number;
    }
  | {
      kind: 'local_http';
      baseUrl: string;
      model: string;
      protocol: 'openai-embeddings';
    }
  | {
      kind: 'provider';
      providerId: string;
      model: string;
      protocol: 'openai-embeddings' | 'cloudflare' | 'bedrock';
      /** Persisted with the generation so older unprefixed vectors stay queryable. */
      inputFormat?: 'query-passage';
    }
  | { kind: 'disabled' };

export type RerankerTarget =
  | {
      kind: 'onnx';
      /** `auto` resolves per-machine in the semantic worker and never changes
       * an embedding generation because rerankers do not define vector space. */
      model: 'auto' | (string & {});
      revision?: string;
      cacheDir?: string;
      dtype?: SemanticOnnxDtype;
      maxTokens?: number;
    }
  | {
      kind: 'local_http';
      baseUrl: string;
      model: string;
      protocol: 'cohere-rerank' | 'openai-rerank';
    }
  | {
      kind: 'provider';
      providerId: string;
      model: string;
      protocol: 'cohere-rerank' | 'openai-rerank' | 'cloudflare' | 'bedrock';
    }
  | { kind: 'disabled' };

export interface SemanticProfileRow {
  purpose: SemanticPurpose;
  embedding_target: EmbeddingTarget;
  reranker_target: RerankerTarget;
  created_at: string;
  updated_at: string;
}

export type SemanticGenerationStatus = 'building' | 'ready' | 'failed' | 'retired';

export interface SemanticGenerationRow {
  id: number;
  purpose: SemanticPurpose;
  fingerprint: string;
  embedding_target: EmbeddingTarget;
  dimension: number;
  status: SemanticGenerationStatus;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface SemanticNamespaceGenerationRow {
  namespace: string;
  purpose: SemanticPurpose;
  active_generation_id: number | null;
  building_generation_id: number | null;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  delta_items: number;
  last_error: string | null;
  updated_at: string;
}

export type SemanticModelStatus = 'unknown' | 'ready' | 'error';

export interface SemanticModelCatalogRow {
  id: string;
  capability: SemanticCapability;
  source: 'default' | 'detected' | 'custom';
  provider_id: string | null;
  model_id: string;
  config: Record<string, unknown>;
  dimension: number | null;
  status: SemanticModelStatus;
  last_probe_at: string | null;
  last_probe_error: string | null;
  created_at: string;
  updated_at: string;
}

export type SemanticItemStatus = 'pending' | 'indexed' | 'failed' | 'stale';

export interface SemanticItemRow {
  generation_id: number;
  namespace: string;
  item_key: string;
  source_hash: string;
  vector_id: string | null;
  chunk_index: number;
  status: SemanticItemStatus;
  attempts: number;
  error: string | null;
  updated_at: string;
}

export type SemanticJobKind = 'build' | 'backfill' | 'delta' | 'cleanup';

export type SemanticJobStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface SemanticJobRow {
  id: number;
  generation_id: number | null;
  namespace: string;
  kind: SemanticJobKind;
  status: SemanticJobStatus;
  priority: number;
  cursor: Record<string, unknown> | null;
  expected_items: number;
  processed_items: number;
  failed_items: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
}

export interface SemanticMutationInput {
  namespace: string;
  itemKeys: readonly string[];
  operation: 'upsert' | 'delete';
  /** Keep serving on lexical sources until an operator explicitly rebuilds
   * this namespace. Used when a structural scan can prove drift but cannot
   * enumerate exact semantic paths without a whole-project content read. */
  requiresExplicitReindex?: boolean;
  /** Optional durable fence for a relational mutation that has not settled
   * yet. Fences are never coalesced: one running job represents one caller,
   * allowing concurrent documentation sources to block activation
   * independently until each caller reaches its `finally` block. */
  fence?: {
    token: string;
    owner: string;
    /** Optional cross-process lease. A new server must not recover a fence
     * owned by a still-running CLI/MCP writer merely because its owner id is
     * different from the server process. */
    leaseMs?: number;
  };
}

export interface CapturedSemanticMutationJob {
  id: number;
  expected_items: number;
}

export interface SemanticMutationPassResult {
  state: SemanticNamespaceGenerationRow;
  pending: boolean;
  activated: boolean;
  completed_job_ids: number[];
}

export interface SemanticStatus {
  profiles: SemanticProfileRow[];
  generations: SemanticGenerationRow[];
  namespaces: SemanticNamespaceGenerationRow[];
  jobs: Record<SemanticJobStatus, number>;
  totals: {
    expected_items: number;
    indexed_items: number;
    failed_items: number;
    delta_items: number;
  };
}

export type JsonProfileRow = Omit<SemanticProfileRow, 'embedding_target' | 'reranker_target'> & {
  embedding_target: string;
  reranker_target: string;
};

export type JsonGenerationRow = Omit<SemanticGenerationRow, 'embedding_target'> & { embedding_target: string };

export type JsonModelRow = Omit<SemanticModelCatalogRow, 'config'> & { config: string };

export type JsonJobRow = Omit<SemanticJobRow, 'cursor'> & { cursor: string | null };
