/**
 * LSHIndexStore — CRUD over the LSH bucketing tables (migration 082).
 *
 * Two tables work together:
 *   - embedding_simhash_signatures: 1 row per entity, holds the 32-bit
 *     signature for filtered cosine-similarity comparison.
 *   - embedding_lsh_buckets: M rows per entity (one per hash function);
 *     queried by `findCandidatesByBuckets(...)` to get the candidate
 *     set for a query.
 *
 * The upsert path uses `INSERT OR REPLACE` so re-indexing the same entity
 * is idempotent. The lookup path returns DISTINCT entity_ids that match in
 * ANY of the query buckets — the union pattern gives high recall.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type LshEntityType = 'file' | 'symbol';

export interface SimHashRow {
  project_id: number;
  entity_type: LshEntityType;
  entity_id: number;
  signature: number;
  dim: number;
  params_hash: string;
  updated_at: string;
}

export interface LshUpsertInput {
  project_id: number;
  entity_type: LshEntityType;
  entity_id: number;
  signature: number;
  buckets: number[];
  dim: number;
  params_hash: string;
}

export class LshIndexStore {
  constructor(private db: DB) {}

  /** Upsert one entity's signature + bucket assignments in a single transaction. */
  upsert(input: LshUpsertInput): void {
    const sigStmt = this.db.prepare(
      `INSERT INTO embedding_simhash_signatures (
         project_id, entity_type, entity_id, signature, dim, params_hash, updated_at
       ) VALUES (
         @project_id, @entity_type, @entity_id, @signature, @dim, @params_hash, datetime('now')
       )
       ON CONFLICT(project_id, entity_type, entity_id) DO UPDATE SET
         signature   = excluded.signature,
         dim         = excluded.dim,
         params_hash = excluded.params_hash,
         updated_at  = datetime('now')`,
    );
    const deleteBucketsStmt = this.db.prepare(
      `DELETE FROM embedding_lsh_buckets
        WHERE project_id = @project_id
          AND entity_type = @entity_type
          AND entity_id   = @entity_id`,
    );
    const insertBucketStmt = this.db.prepare(
      `INSERT INTO embedding_lsh_buckets (project_id, entity_type, entity_id, hash_idx, bucket_hash)
       VALUES (@project_id, @entity_type, @entity_id, @hash_idx, @bucket_hash)`,
    );
    const tx = this.db.transaction((row: LshUpsertInput) => {
      sigStmt.run({
        project_id: row.project_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        signature: row.signature,
        dim: row.dim,
        params_hash: row.params_hash,
      });
      deleteBucketsStmt.run({
        project_id: row.project_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
      });
      for (let i = 0; i < row.buckets.length; i++) {
        insertBucketStmt.run({
          project_id: row.project_id,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          hash_idx: i,
          bucket_hash: row.buckets[i],
        });
      }
    });
    tx(input);
  }

  /** Bulk upsert. Each call is wrapped in one transaction. */
  upsertMany(rows: LshUpsertInput[]): void {
    if (rows.length === 0) return;
    const sigStmt = this.db.prepare(
      `INSERT INTO embedding_simhash_signatures (
         project_id, entity_type, entity_id, signature, dim, params_hash, updated_at
       ) VALUES (
         @project_id, @entity_type, @entity_id, @signature, @dim, @params_hash, datetime('now')
       )
       ON CONFLICT(project_id, entity_type, entity_id) DO UPDATE SET
         signature   = excluded.signature,
         dim         = excluded.dim,
         params_hash = excluded.params_hash,
         updated_at  = datetime('now')`,
    );
    const deleteBucketsStmt = this.db.prepare(
      `DELETE FROM embedding_lsh_buckets
        WHERE project_id = @project_id
          AND entity_type = @entity_type
          AND entity_id   = @entity_id`,
    );
    const insertBucketStmt = this.db.prepare(
      `INSERT INTO embedding_lsh_buckets (project_id, entity_type, entity_id, hash_idx, bucket_hash)
       VALUES (@project_id, @entity_type, @entity_id, @hash_idx, @bucket_hash)`,
    );
    const tx = this.db.transaction((batch: LshUpsertInput[]) => {
      for (const row of batch) {
        sigStmt.run({
          project_id: row.project_id,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          signature: row.signature,
          dim: row.dim,
          params_hash: row.params_hash,
        });
        deleteBucketsStmt.run({
          project_id: row.project_id,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
        });
        for (let i = 0; i < row.buckets.length; i++) {
          insertBucketStmt.run({
            project_id: row.project_id,
            entity_type: row.entity_type,
            entity_id: row.entity_id,
            hash_idx: i,
            bucket_hash: row.buckets[i],
          });
        }
      }
    });
    tx(rows);
  }

  /**
   * Return distinct entity_ids that share at least one bucket with the
   * query's bucket projection.
   */
  findCandidatesByBuckets(opts: {
    project_id: number;
    entity_type: LshEntityType;
    buckets: number[];
  }): number[] {
    if (opts.buckets.length === 0) return [];
    const conds: string[] = [];
    const params: Record<string, unknown> = {
      project_id: opts.project_id,
      entity_type: opts.entity_type,
    };
    for (let i = 0; i < opts.buckets.length; i++) {
      conds.push(`(hash_idx = @h${i} AND bucket_hash = @b${i})`);
      params[`h${i}`] = i;
      params[`b${i}`] = opts.buckets[i];
    }
    const sql =
      `SELECT DISTINCT entity_id FROM embedding_lsh_buckets
        WHERE project_id  = @project_id
          AND entity_type = @entity_type
          AND (${conds.join(' OR ')})`;
    const rows = this.db.prepare(sql).all(params) as Array<{ entity_id: number }>;
    return rows.map((r) => r.entity_id);
  }

  /** Read a single entity's signature — used by the cosine refinement step. */
  getSignature(opts: {
    project_id: number;
    entity_type: LshEntityType;
    entity_id: number;
  }): SimHashRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM embedding_simhash_signatures
         WHERE project_id = @project_id
           AND entity_type = @entity_type
           AND entity_id   = @entity_id`,
      )
      .get(opts) as SimHashRow | undefined;
    return row ?? null;
  }

  /**
   * Bulk read signatures for a candidate set — used to rank the union of
   * bucket matches by Hamming distance before going to vector store.
   */
  getSignaturesBulk(
    project_id: number,
    entity_type: LshEntityType,
    entityIds: number[],
  ): SimHashRow[] {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM embedding_simhash_signatures
         WHERE project_id  = ?
           AND entity_type = ?
           AND entity_id IN (${placeholders})`,
      )
      .all(project_id, entity_type, ...entityIds) as SimHashRow[];
    return rows;
  }

  /** Drop all LSH state for an entity. Called when the entity is deleted. */
  remove(opts: { project_id: number; entity_type: LshEntityType; entity_id: number }): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM embedding_lsh_buckets
            WHERE project_id = ? AND entity_type = ? AND entity_id = ?`,
        )
        .run(opts.project_id, opts.entity_type, opts.entity_id);
      this.db
        .prepare(
          `DELETE FROM embedding_simhash_signatures
            WHERE project_id = ? AND entity_type = ? AND entity_id = ?`,
        )
        .run(opts.project_id, opts.entity_type, opts.entity_id);
    });
    tx();
  }

  /** Diagnostics: per-bucket cardinality (helps detect skewed projections). */
  bucketHistogram(opts: { project_id: number; entity_type: LshEntityType; hash_idx: number }):
    Array<{ bucket_hash: number; count: number }> {
    return this.db
      .prepare(
        `SELECT bucket_hash, COUNT(*) AS count
         FROM embedding_lsh_buckets
        WHERE project_id  = @project_id
          AND entity_type = @entity_type
          AND hash_idx    = @hash_idx
        GROUP BY bucket_hash
        ORDER BY count DESC
        LIMIT 50`,
      )
      .all(opts) as Array<{ bucket_hash: number; count: number }>;
  }
}
