/**
 * LSHIndex — high-level wrapper that turns embeddings into bucket+signature
 * pairs and delegates persistence to the LshIndexStore.
 *
 * Usage on the indexing side:
 *   const lsh = new LSHIndex({ dim: 768, store });
 *   for (const file of files) {
 *     lsh.index({ projectId, entityType: 'file', entityId: file.id, embedding });
 *   }
 *
 * Usage on the search side:
 *   const candidates = lsh.candidatesFor(queryEmbedding, { projectId, entityType: 'file', limit: 200 });
 *   // pass `candidates` (entityIds) to the vector store for full-precision rerank.
 *
 * Why this matters: instead of scanning every embedding in the project for
 * cosine similarity, the LSH lookup narrows the candidate set to ~hundreds
 * via integer index lookups. Recall stays > 95% with 2 hashes × 32 hyperplanes.
 */
import { createHash } from 'node:crypto';
import {
  bucketize,
  computeLshEntry,
  DEFAULT_NUM_BUCKETS,
  DEFAULT_NUM_HASHES,
  DEFAULT_NUM_HYPERPLANES,
  estimateCosineFromHamming,
  generateHyperplanes,
  generateMultiHashParams,
  hammingDistance,
  simHashSignature,
  type MultiHashParams,
} from '@mcp/candidate-pipeline/scorers/lsh.js';
import type {
  LshEntityType,
  LshIndexStore,
} from '@mcp/store/lsh-index-store.js';

export interface LSHIndexConfig {
  /** Dimensionality of input embeddings — determines hyperplane size. */
  dim: number;
  /** Backing store. */
  store: LshIndexStore;
  /** Hyperplane count. Default 32. */
  numHyperplanes?: number;
  /** Hash function count. Default 2. */
  numHashes?: number;
  /** Bucket space per hash. Default 4096 — keeps buckets sparse. */
  numBuckets?: number;
  /** Stable seed so signatures are reproducible across processes. */
  seed?: number;
}

export interface IndexInput {
  projectId: number;
  entityType: LshEntityType;
  entityId: number;
  embedding: Float32Array | number[];
}

export interface CandidateLookupOpts {
  projectId: number;
  entityType: LshEntityType;
  /** Cap on returned candidates (post-Hamming-rank). 0 = unlimited. */
  limit?: number;
}

export interface RankedCandidate {
  entityId: number;
  /** SimHash distance (lower = closer). */
  hammingDistance: number;
  /** Estimated cosine similarity (derived from hammingDistance). */
  estimatedCosine: number;
}

export class LSHIndex {
  readonly numHyperplanes: number;
  readonly numHashes: number;
  readonly numBuckets: number;
  readonly dim: number;
  readonly paramsHash: string;
  private hyperplanes: Float32Array[];
  private multiHashParams: MultiHashParams;

  constructor(private cfg: LSHIndexConfig) {
    this.dim = cfg.dim;
    this.numHyperplanes = cfg.numHyperplanes ?? DEFAULT_NUM_HYPERPLANES;
    this.numHashes = cfg.numHashes ?? DEFAULT_NUM_HASHES;
    this.numBuckets = cfg.numBuckets ?? DEFAULT_NUM_BUCKETS;
    const seed = cfg.seed ?? 0x9e3779b1;
    this.hyperplanes = generateHyperplanes(this.dim, this.numHyperplanes, seed);
    this.multiHashParams = generateMultiHashParams(this.numHashes, this.numBuckets, seed ^ 0xc0ffee01);
    this.paramsHash = createHash('sha256')
      .update(`${this.dim}:${this.numHyperplanes}:${this.numHashes}:${this.numBuckets}:${seed}`)
      .digest('hex');
  }

  /** Stable string id that consumers compare to detect parameter changes. */
  getParamsHash(): string { return this.paramsHash; }

  /** Persist (signature, buckets) for one entity. */
  index(input: IndexInput): void {
    const entry = computeLshEntry(
      String(input.entityId),
      input.embedding,
      this.hyperplanes,
      this.multiHashParams,
    );
    this.cfg.store.upsert({
      project_id: input.projectId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      signature: entry.signature,
      buckets: entry.buckets,
      dim: this.dim,
      params_hash: this.paramsHash,
    });
  }

  /** Bulk index — single transaction in the underlying store. */
  indexMany(inputs: IndexInput[]): void {
    if (inputs.length === 0) return;
    const rows = inputs.map((input) => {
      const entry = computeLshEntry(
        String(input.entityId),
        input.embedding,
        this.hyperplanes,
        this.multiHashParams,
      );
      return {
        project_id: input.projectId,
        entity_type: input.entityType,
        entity_id: input.entityId,
        signature: entry.signature,
        buckets: entry.buckets,
        dim: this.dim,
        params_hash: this.paramsHash,
      };
    });
    this.cfg.store.upsertMany(rows);
  }

  /**
   * Look up candidates whose buckets intersect with `queryEmbedding`'s
   * buckets, then rank by Hamming distance (≈ inverse cosine similarity).
   */
  candidatesFor(
    queryEmbedding: Float32Array | number[],
    opts: CandidateLookupOpts,
  ): RankedCandidate[] {
    const querySig = simHashSignature(queryEmbedding, this.hyperplanes);
    const queryBuckets = bucketize(querySig, this.multiHashParams);

    const entityIds = this.cfg.store.findCandidatesByBuckets({
      project_id: opts.projectId,
      entity_type: opts.entityType,
      buckets: queryBuckets,
    });
    if (entityIds.length === 0) return [];

    const sigs = this.cfg.store.getSignaturesBulk(opts.projectId, opts.entityType, entityIds);
    const ranked = sigs
      .map((s) => {
        const hd = hammingDistance(querySig, s.signature);
        return {
          entityId: s.entity_id,
          hammingDistance: hd,
          estimatedCosine: estimateCosineFromHamming(hd, this.numHyperplanes),
        };
      })
      .sort((a, b) => a.hammingDistance - b.hammingDistance);

    return opts.limit && opts.limit > 0 ? ranked.slice(0, opts.limit) : ranked;
  }

  /** Drop all LSH state for an entity (called after delete). */
  remove(opts: { projectId: number; entityType: LshEntityType; entityId: number }): void {
    this.cfg.store.remove({
      project_id: opts.projectId,
      entity_type: opts.entityType,
      entity_id: opts.entityId,
    });
  }
}
