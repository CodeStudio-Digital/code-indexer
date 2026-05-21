/**
 * LshIndexingSink — optional hook the Indexer calls after a vector-store
 * upsert. Default impl is a no-op; the application wires a real impl
 * when LSH support is desired.
 *
 * Why a sink (not a direct call): keeps the Indexer agnostic of LSH
 * details (signature dim, hash count, bucket space). The sink owns those
 * decisions and can be swapped (in-memory, distributed, sharded by
 * project) without touching the indexer.
 *
 * Entity-id mapping: the vector store uses TEXT vector_ids (e.g.
 * `file::1234`, `sym::5678`). LSH tables use INTEGER entity_id. We hash
 * the vector_id string deterministically via FNV-1a so the same vector_id
 * always maps to the same entity_id. Search-side lookups must apply the
 * SAME hash to reverse-map LSH candidates back to vector_ids.
 */
import type { VectorRecord } from '@mcp/shared/types.js';
import type { LSHIndex } from '../search/lsh-index.js';

export type LshEntityType = 'file' | 'symbol';

export interface LshIndexingSink {
  /**
   * Called after the indexer successfully upserts a batch into the
   * vector store. Implementations should be fast and never throw —
   * indexing is the hot path.
   */
  afterUpsert(projectId: number, records: ReadonlyArray<VectorRecord>): void | Promise<void>;
  /**
   * Called when a vector is deleted. Implementations should drop the
   * corresponding LSH state.
   */
  afterDelete?(projectId: number, vectorIds: ReadonlyArray<string>): void | Promise<void>;
}

export class NullLshIndexingSink implements LshIndexingSink {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  afterUpsert(_projectId: number, _records: ReadonlyArray<VectorRecord>): void { /* no-op */ }
}

/**
 * Hash a vector_id string to a 32-bit non-zero integer. Deterministic +
 * collision-resistant enough for entity_id usage at indexer scale
 * (typical project: 10s of thousands of files, low collision rate).
 *
 * The "+1 if zero" guard reserves 0 as a sentinel (matches the LSH
 * bucket-zero reservation in `@mcp/candidate-pipeline/scorers/lsh`).
 */
export function vectorIdToEntityId(vectorId: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < vectorId.length; i++) {
    h ^= vectorId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const result = h >>> 0;
  return result === 0 ? 1 : result;
}

/** Map vector-store metadata.type onto the LSH entity_type (collapses symbol+symbol_body). */
export function metadataTypeToLshEntityType(type: unknown): LshEntityType {
  if (type === 'file') return 'file';
  return 'symbol';
}

/**
 * Concrete sink that pushes a batch of vector records into LSH using the
 * configured LSHIndex.
 */
export class RealLshIndexingSink implements LshIndexingSink {
  constructor(private lshIndex: LSHIndex) {}

  afterUpsert(projectId: number, records: ReadonlyArray<VectorRecord>): void {
    const inputs = records.map((r) => ({
      projectId,
      entityType: metadataTypeToLshEntityType(r.metadata?.type),
      entityId: vectorIdToEntityId(r.id),
      embedding: Float32Array.from(r.values),
    }));
    try {
      this.lshIndex.indexMany(inputs);
    } catch {
      // LSH is best-effort — never break indexing if the LSH store hiccups.
    }
  }

  afterDelete(projectId: number, vectorIds: ReadonlyArray<string>): void {
    for (const vid of vectorIds) {
      try {
        this.lshIndex.remove({
          projectId,
          entityType: 'file', // try file first
          entityId: vectorIdToEntityId(vid),
        });
        this.lshIndex.remove({
          projectId,
          entityType: 'symbol',
          entityId: vectorIdToEntityId(vid),
        });
      } catch { /* best-effort */ }
    }
  }
}
