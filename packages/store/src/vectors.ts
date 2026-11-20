import type { VectorMatch, VectorRecord } from '@mcp/shared/types.js';
import type { EmbeddingTarget } from './semantic-store.js';

/** Immutable write-space selected before a document embedding batch starts.
 * The local worker revalidates every field after its physical SQLite write
 * queue grants the turn, so a concurrent profile rollout cannot redirect an
 * already-produced vector into a different generation with the same size. */
export interface VectorWriteTarget {
  generationId: number;
  generationFingerprint: string;
  embeddingFingerprint: string;
  embeddingTarget: EmbeddingTarget;
}

/** Forced rebuilds retain the service fingerprint and append a strictly
 * shaped rollout nonce. Do not use a plain prefix check here: a model id may
 * itself be a prefix of another model id. */
export function generationMatchesEmbeddingFingerprint(
  generationFingerprint: string,
  embeddingFingerprint: string,
): boolean {
  return embeddingFingerprintForGeneration(generationFingerprint) === embeddingFingerprint;
}

/** Recover the service-space fingerprint from a persisted generation id.
 * Only the coordinator's complete forced-rollout suffix is stripped. */
export function embeddingFingerprintForGeneration(generationFingerprint: string): string {
  const forced = /^(.*):rebuild:\d+:[0-9a-f]{1,6}$/i.exec(generationFingerprint);
  const withoutRebuild = forced?.[1] ?? generationFingerprint;
  const dimension = /^(.*):space-dimension:\d+$/i.exec(withoutRebuild);
  return dimension ? dimension[1]!.replace(/:input-layout:v2$/, '') : withoutRebuild;
}

/** Central-ledger view of one logical embedding item. The physical vector
 * store deliberately exposes this small projection instead of leaking the
 * control-plane database implementation into indexer/services packages. */
export interface VectorItemState {
  itemKey: string;
  sourceHash: string;
  vectorId: string | null;
  chunkIndex: number;
  status: 'pending' | 'indexed' | 'failed' | 'stale';
  attempts: number;
  error: string | null;
}

export interface VectorSearchOptions {
  signal?: AbortSignal;
  topK?: number;
  filter?: Record<string, string>;
  /** Eligible metadata types, applied by KNN before topK. */
  types?: readonly string[];
  namespace?: string;
  /** Immutable read target returned by the namespace-aware query embedder.
   * When present, local routing must not resolve the active pointer again. */
  generationId?: number;
}

/**
 * Storage contract used by indexing and search.
 *
 * Concrete storage is local-only and is resolved by LocalVectorRouter. Keeping
 * this interface in a small dependency-free module lets indexer/services stay
 * unaware of sqlite connection ownership and physical database placement.
 */
export interface VectorStore {
  upsert(
    records: VectorRecord[],
    namespace?: string,
    writeTarget?: VectorWriteTarget,
  ): Promise<number>;
  search(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorMatch[]>;
  deleteByIds(
    ids: string[],
    namespace?: string,
    writeTarget?: VectorWriteTarget,
  ): Promise<number>;
  /** Read the item ledger for the generation currently receiving writes.
   * An empty/missing key list means all items in that namespace generation. */
  listItems?(
    namespace: string,
    itemKeys?: string[],
    writeTarget?: VectorWriteTarget,
  ): Promise<VectorItemState[]>;
  /** Resolve vector ids through semantic_items and delete them from both the
   * active and in-construction generations. */
  deleteByItemKeys?(itemKeys: string[], namespace: string): Promise<number>;
  /** Remove every active/building vector plus the logical namespace state. */
  deleteNamespace?(namespace: string): Promise<number>;
  isAvailable(): Promise<boolean>;
}

/** FTS-only fallback used when semantic indexing is disabled or unavailable. */
export class NullVectorStore implements VectorStore {
  async upsert(
    _records: VectorRecord[],
    _namespace?: string,
    _writeTarget?: VectorWriteTarget,
  ): Promise<number> {
    return 0;
  }

  async search(
    _queryVector: number[],
    _options?: VectorSearchOptions,
  ): Promise<VectorMatch[]> {
    return [];
  }

  async deleteByIds(
    _ids: string[],
    _namespace?: string,
    _writeTarget?: VectorWriteTarget,
  ): Promise<number> {
    return 0;
  }

  async listItems(
    _namespace: string,
    _itemKeys?: string[],
    _writeTarget?: VectorWriteTarget,
  ): Promise<VectorItemState[]> {
    return [];
  }

  async deleteByItemKeys(_itemKeys: string[], _namespace: string): Promise<number> {
    return 0;
  }

  async deleteNamespace(_namespace: string): Promise<number> {
    return 0;
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}
