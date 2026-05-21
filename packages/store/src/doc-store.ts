/**
 * DocStore — CRUD over the documentation-corpus tables introduced by
 * migration 086 (`doc_collections`, `doc_sources`, `doc_chunks`,
 * `doc_chunk_vectors`) + the FTS5 helpers needed by `DocHybridSearch`.
 *
 * Tables are GLOBAL (no `project_id`) — collections are shared across all
 * projects. LLM model selection for ingestion/search lives in
 * `pipeline_provider_bindings` (migration 085), not on the collection row.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

// ─── Types ──────────────────────────────────────────────────────────

export type DocCollectionStatus = 'idle' | 'indexing' | 'error';
export type DocSourceType = 'pdf' | 'url';
export type DocSourceStatus = 'queued' | 'fetching' | 'indexing' | 'done' | 'error';

export interface DocCollection {
  id: number;
  name: string;
  description: string | null;
  status: DocCollectionStatus;
  status_message: string | null;
  embedding_provider_id: string | null;
  chunk_count: number;
  source_count: number;
  created_at: string;
  updated_at: string;
}

export interface DocCollectionInput {
  name: string;
  description?: string | null;
  embedding_provider_id?: string | null;
}

export interface DocCrawlConfig {
  enabled?: boolean;
  max_pages?: number;
  max_depth?: number;
  same_origin?: boolean;
  include_pattern?: string | null;
  exclude_pattern?: string | null;
  /**
   * Literal substring the URL MUST contain to be accepted. Applied AFTER
   * include/exclude regex but BEFORE the fetcher runs. Empty/null disables
   * the check. Common use: pin a manual version (`/6000.3/Documentation/Manual/`)
   * so a crawl from inside that version doesn't wander into siblings.
   */
  required_path?: string | null;
  /**
   * When true, the crawler runs an LLM on the seed page (depth=0) to
   * surface URLs that cheerio missed — typically navigation trees built
   * by client-side JS, data-attribute routes, or embedded JSON page
   * maps. 1 LLM call per source. Falls back silently to cheerio-only
   * when no `link_extractor` binding is configured. See Addendum 4.
   */
  llm_extract_links?: boolean;
}

export interface DocSource {
  id: number;
  collection_id: number;
  type: DocSourceType;
  uri: string;
  title: string | null;
  status: DocSourceStatus;
  error_message: string | null;
  content_hash: string | null;
  chunk_count: number;
  page_count: number;
  pages_accepted: number;
  pages_rejected: number;
  last_indexed_at: string | null;
  crawl_enabled: boolean;
  crawl_max_pages: number;
  crawl_max_depth: number;
  crawl_same_origin: boolean;
  crawl_include_pattern: string | null;
  crawl_exclude_pattern: string | null;
  crawl_required_path: string | null;
  crawl_llm_extract_links: boolean;
  pdf_size_bytes: number | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface DocSourceInput {
  collection_id: number;
  type: DocSourceType;
  uri: string;
  title?: string | null;
  crawl?: DocCrawlConfig;
  pdf_size_bytes?: number | null;
}

export interface DocChunkInput {
  collection_id: number;
  source_id: number;
  ord: number;
  heading_path?: string | null;
  content: string;
  content_hash: string;
  summary?: string | null;
  concepts?: string[];
  token_count?: number;
  source_uri?: string | null;
}

export interface DocChunk {
  id: number;
  collection_id: number;
  source_id: number;
  ord: number;
  heading_path: string | null;
  content: string;
  content_hash: string;
  summary: string | null;
  concepts: string[];
  token_count: number;
  embedding_hash: string | null;
  embedding_provider_id: string | null;
  source_uri: string | null;
  created_at: string;
}

export interface DocFtsHit {
  chunk_id: number;
  rank: number;
}

/**
 * Truth-source view of a source's persistence + embedding state.
 * Built by JOINing `doc_chunks` and `doc_chunk_vectors` so it doesn't
 * rely on the cached `doc_sources.chunk_count` (which lags during/after
 * a hang). Returned by the `GET /sources/:id/health` route + used by
 * the SourceList badge.
 */
export interface DocSourceHealth {
  source_id: number;
  status: DocSourceStatus;
  chunks_persisted: number;
  chunks_embedded: number;
  embedding_complete: boolean;
  missing_count: number;
  last_indexed_at: string | null;
}

/**
 * (vector_id, provider) pair — used both as the input to remote delete
 * calls and as the row shape for the tombstone retry queue.
 */
export interface DocVectorRef {
  vector_id: string;
  provider: string;
}

export interface DocVectorTombstoneRow extends DocVectorRef {
  id: number;
  deleted_at: string;
  last_retry_at: string | null;
  retry_count: number;
  last_error: string | null;
}

// ─── Row mappers ────────────────────────────────────────────────────

function boolFromInt(n: number | boolean): boolean {
  return typeof n === 'number' ? n !== 0 : !!n;
}

function mapCollection(row: Record<string, unknown>): DocCollection {
  return {
    id: row.id as number,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    status: row.status as DocCollectionStatus,
    status_message: (row.status_message as string | null) ?? null,
    embedding_provider_id: (row.embedding_provider_id as string | null) ?? null,
    chunk_count: row.chunk_count as number,
    source_count: row.source_count as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapSource(row: Record<string, unknown>): DocSource {
  return {
    id: row.id as number,
    collection_id: row.collection_id as number,
    type: row.type as DocSourceType,
    uri: row.uri as string,
    title: (row.title as string | null) ?? null,
    status: row.status as DocSourceStatus,
    error_message: (row.error_message as string | null) ?? null,
    content_hash: (row.content_hash as string | null) ?? null,
    chunk_count: row.chunk_count as number,
    page_count: row.page_count as number,
    pages_accepted: row.pages_accepted as number,
    pages_rejected: row.pages_rejected as number,
    last_indexed_at: (row.last_indexed_at as string | null) ?? null,
    crawl_enabled: boolFromInt(row.crawl_enabled as number),
    crawl_max_pages: row.crawl_max_pages as number,
    crawl_max_depth: row.crawl_max_depth as number,
    crawl_same_origin: boolFromInt(row.crawl_same_origin as number),
    crawl_include_pattern: (row.crawl_include_pattern as string | null) ?? null,
    crawl_exclude_pattern: (row.crawl_exclude_pattern as string | null) ?? null,
    crawl_required_path: (row.crawl_required_path as string | null) ?? null,
    crawl_llm_extract_links: boolFromInt(row.crawl_llm_extract_links as number),
    pdf_size_bytes: (row.pdf_size_bytes as number | null) ?? null,
    cost_usd: (row.cost_usd as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapChunk(row: Record<string, unknown>): DocChunk {
  let concepts: string[] = [];
  const raw = row.concepts as string | null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) concepts = parsed.filter((c): c is string => typeof c === 'string');
    } catch { /* ignore malformed JSON */ }
  }
  return {
    id: row.id as number,
    collection_id: row.collection_id as number,
    source_id: row.source_id as number,
    ord: row.ord as number,
    heading_path: (row.heading_path as string | null) ?? null,
    content: row.content as string,
    content_hash: row.content_hash as string,
    summary: (row.summary as string | null) ?? null,
    concepts,
    token_count: (row.token_count as number) ?? 0,
    embedding_hash: (row.embedding_hash as string | null) ?? null,
    embedding_provider_id: (row.embedding_provider_id as string | null) ?? null,
    source_uri: (row.source_uri as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

// ─── Store ──────────────────────────────────────────────────────────

export class DocStore {
  constructor(private db: DB) {}

  // ─── Collections ─────────────────────────────────────────────────

  createCollection(input: DocCollectionInput): DocCollection {
    const stmt = this.db.prepare(`
      INSERT INTO doc_collections (name, description, embedding_provider_id)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(
      input.name,
      input.description ?? null,
      input.embedding_provider_id ?? null,
    );
    return this.getCollection(result.lastInsertRowid as number)!;
  }

  getCollection(id: number): DocCollection | null {
    const row = this.db.prepare('SELECT * FROM doc_collections WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapCollection(row) : null;
  }

  getCollectionByName(name: string): DocCollection | null {
    const row = this.db.prepare('SELECT * FROM doc_collections WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? mapCollection(row) : null;
  }

  listCollections(): DocCollection[] {
    const rows = this.db.prepare('SELECT * FROM doc_collections ORDER BY name').all() as Array<
      Record<string, unknown>
    >;
    return rows.map(mapCollection);
  }

  updateCollectionStatus(
    id: number,
    status: DocCollectionStatus,
    message?: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE doc_collections
            SET status = ?, status_message = ?, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(status, message ?? null, id);
  }

  refreshCollectionCounts(id: number): void {
    this.db
      .prepare(
        `UPDATE doc_collections
            SET chunk_count  = (SELECT COUNT(*) FROM doc_chunks  WHERE collection_id = ?),
                source_count = (SELECT COUNT(*) FROM doc_sources WHERE collection_id = ?),
                updated_at   = datetime('now')
          WHERE id = ?`,
      )
      .run(id, id, id);
  }

  deleteCollection(id: number): void {
    this.db.prepare('DELETE FROM doc_collections WHERE id = ?').run(id);
  }

  // ─── Sources ─────────────────────────────────────────────────────

  createSource(input: DocSourceInput): DocSource {
    const crawl = input.crawl ?? {};
    const stmt = this.db.prepare(`
      INSERT INTO doc_sources (
        collection_id, type, uri, title,
        crawl_enabled, crawl_max_pages, crawl_max_depth, crawl_same_origin,
        crawl_include_pattern, crawl_exclude_pattern, crawl_required_path,
        crawl_llm_extract_links,
        pdf_size_bytes
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?,
        ?
      )
    `);
    const result = stmt.run(
      input.collection_id,
      input.type,
      input.uri,
      input.title ?? null,
      crawl.enabled ? 1 : 0,
      crawl.max_pages ?? 1,
      crawl.max_depth ?? 0,
      crawl.same_origin === false ? 0 : 1,
      crawl.include_pattern ?? null,
      crawl.exclude_pattern ?? null,
      normalizeRequiredPath(crawl.required_path),
      crawl.llm_extract_links ? 1 : 0,
      input.pdf_size_bytes ?? null,
    );
    this.refreshCollectionCounts(input.collection_id);
    return this.getSource(result.lastInsertRowid as number)!;
  }

  getSource(id: number): DocSource | null {
    const row = this.db.prepare('SELECT * FROM doc_sources WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapSource(row) : null;
  }

  listSourcesByCollection(collectionId: number): DocSource[] {
    const rows = this.db
      .prepare('SELECT * FROM doc_sources WHERE collection_id = ? ORDER BY created_at DESC')
      .all(collectionId) as Array<Record<string, unknown>>;
    return rows.map(mapSource);
  }

  updateSourceStatus(id: number, status: DocSourceStatus, errorMessage?: string | null): void {
    this.db
      .prepare(
        `UPDATE doc_sources
            SET status = ?, error_message = ?, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(status, errorMessage ?? null, id);
  }

  /**
   * Patch counter columns + optional cost increment. Pass only the fields
   * you want to overwrite; the rest stay as-is. `cost_usd` is set
   * absolutely (caller passes the accumulated total), not added.
   */
  updateSourceStats(
    id: number,
    patch: Partial<{
      content_hash: string | null;
      title: string | null;
      chunk_count: number;
      page_count: number;
      pages_accepted: number;
      pages_rejected: number;
      cost_usd: number;
      last_indexed_at: string | null;
    }>,
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
    if (fields.length === 0) return;
    fields.push(`updated_at = datetime('now')`);
    this.db.prepare(`UPDATE doc_sources SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  }

  deleteSource(id: number): void {
    const src = this.getSource(id);
    this.db.prepare('DELETE FROM doc_sources WHERE id = ?').run(id);
    if (src) this.refreshCollectionCounts(src.collection_id);
  }

  /**
   * Overwrite the persisted crawl config of an existing source row.
   *
   * Called by `ensureSource` when the user re-submits the same URL with
   * a different `crawl` payload (e.g. toggled `llm_extract_links` ON in
   * the UI and clicked "indexar" again). Without this, `ensureSource`
   * would return the old row unchanged and the next "Re-indexar" click
   * (which reads from these columns, not from a request body) would
   * silently use the stale config.
   *
   * All fields are overwritten — pass the full `DocCrawlConfig` you want
   * persisted, not a patch.
   */
  updateSourceCrawlConfig(id: number, crawl: DocCrawlConfig): void {
    this.db
      .prepare(
        `UPDATE doc_sources
            SET crawl_enabled            = @enabled,
                crawl_max_pages          = @max_pages,
                crawl_max_depth          = @max_depth,
                crawl_same_origin        = @same_origin,
                crawl_include_pattern    = @include_pattern,
                crawl_exclude_pattern    = @exclude_pattern,
                crawl_required_path      = @required_path,
                crawl_llm_extract_links  = @llm_extract_links,
                updated_at               = datetime('now')
          WHERE id = @id`,
      )
      .run({
        id,
        enabled: crawl.enabled ? 1 : 0,
        max_pages: crawl.max_pages ?? 1,
        max_depth: crawl.max_depth ?? 0,
        same_origin: crawl.same_origin === false ? 0 : 1,
        include_pattern: crawl.include_pattern ?? null,
        exclude_pattern: crawl.exclude_pattern ?? null,
        required_path: normalizeRequiredPath(crawl.required_path),
        llm_extract_links: crawl.llm_extract_links ? 1 : 0,
      });
  }

  /**
   * One-shot health snapshot for a source: status plus the actual
   * counts of persisted chunks and embedded vectors. The dashboard
   * uses this AFTER a run completes to render the green/amber badge
   * (e.g. "✓ 6331/6331 embedded" vs "⚠ 50 missing embeddings").
   *
   * `chunks_persisted` reads `doc_chunks` directly (truth) rather than
   * the cached `doc_sources.chunk_count` column — that column is only
   * refreshed at phase-7 finalize, so it can lag during/after a hang.
   *
   * `chunks_embedded` joins `doc_chunk_vectors` so a chunk that lost
   * its vector_id mapping (boot recovery wiped tombstones, mid-run
   * crash etc.) shows up as missing.
   */
  getSourceHealth(sourceId: number): DocSourceHealth | null {
    const row = this.db
      .prepare(
        `SELECT s.id AS source_id, s.status, s.last_indexed_at,
                (SELECT COUNT(*) FROM doc_chunks WHERE source_id = s.id) AS chunks_persisted,
                (SELECT COUNT(*) FROM doc_chunk_vectors v
                   JOIN doc_chunks c ON c.id = v.chunk_id
                  WHERE c.source_id = s.id) AS chunks_embedded
           FROM doc_sources s
          WHERE s.id = ?`,
      )
      .get(sourceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const persisted = row.chunks_persisted as number;
    const embedded = row.chunks_embedded as number;
    return {
      source_id: row.source_id as number,
      status: row.status as DocSourceStatus,
      chunks_persisted: persisted,
      chunks_embedded: embedded,
      embedding_complete: persisted > 0 && persisted === embedded,
      missing_count: Math.max(0, persisted - embedded),
      last_indexed_at: (row.last_indexed_at as string | null) ?? null,
    };
  }

  /**
   * Acquire the source so no second runner can ingest it concurrently.
   * Returns true on success, false if it was already in flight (caller
   * should refuse to start a duplicate run).
   *
   * Sources stuck in `fetching|indexing` for more than `staleAfterMs`
   * (default 5 min — no progress event arrived) are considered orphaned
   * (server crash mid-run, network stall, …) and re-acquired. This makes
   * "Re-indexar" usable even after a hang, without requiring the user to
   * delete and recreate the row.
   */
  tryAcquireSource(id: number, staleAfterMs: number = 5 * 60 * 1000): boolean {
    // All bindings are NAMED — better-sqlite3 rejects mixing `?` positional
    // with `@named` when called with a single object payload, throwing
    // "Too few parameter values were provided". This bug surfaced as a
    // hard failure on every indexing attempt — see logs around 2026-05-19.
    const result = this.db
      .prepare(
        `UPDATE doc_sources
            SET status = 'fetching', error_message = NULL, updated_at = datetime('now')
          WHERE id = @id
            AND (
              status NOT IN ('fetching','indexing')
              OR (julianday('now') - julianday(updated_at)) * 86400 * 1000 > @staleMs
            )`,
      )
      .run({ id, staleMs: staleAfterMs });
    return result.changes > 0;
  }

  /**
   * Sweep sources left in `fetching|indexing` by a previous server
   * instance (crash, kill, restart) and mark them `error` so the UI
   * shows a coherent state. Mirrors the `recoverStaleAgentRuns` pattern
   * elsewhere in the codebase. Returns the count of rows touched.
   *
   * Run at server boot from `createApp()`.
   */
  recoverStaleSources(): { recovered: number } {
    const result = this.db
      .prepare(
        `UPDATE doc_sources
            SET status = 'error',
                error_message = COALESCE(error_message, 'Indexação interrompida (servidor reiniciado)'),
                updated_at = datetime('now')
          WHERE status IN ('fetching','indexing')`,
      )
      .run();
    return { recovered: result.changes };
  }

  // ─── Chunks ──────────────────────────────────────────────────────

  /**
   * Insert chunks in a single transaction. Returns the inserted row ids in
   * the same order as the input. Run inside `replaceChunksForSource` when
   * re-indexing — the FTS triggers fire automatically.
   */
  insertChunks(inputs: DocChunkInput[]): number[] {
    if (inputs.length === 0) return [];
    const insert = this.db.prepare(`
      INSERT INTO doc_chunks (
        collection_id, source_id, ord, heading_path,
        content, content_hash, summary, concepts,
        token_count, source_uri
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ids: number[] = [];
    const tx = this.db.transaction((rows: DocChunkInput[]) => {
      for (const c of rows) {
        const r = insert.run(
          c.collection_id,
          c.source_id,
          c.ord,
          c.heading_path ?? null,
          c.content,
          c.content_hash,
          c.summary ?? null,
          c.concepts && c.concepts.length > 0 ? JSON.stringify(c.concepts) : null,
          c.token_count ?? 0,
          c.source_uri ?? null,
        );
        ids.push(r.lastInsertRowid as number);
      }
    });
    tx(inputs);
    return ids;
  }

  /**
   * Idempotent re-index: drop existing chunks for the source and insert the
   * new set in a single transaction. FTS triggers keep the index in sync.
   */
  replaceChunksForSource(sourceId: number, inputs: DocChunkInput[]): number[] {
    const ids: number[] = [];
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM doc_chunks WHERE source_id = ?').run(sourceId);
      if (inputs.length === 0) return;
      const insert = this.db.prepare(`
        INSERT INTO doc_chunks (
          collection_id, source_id, ord, heading_path,
          content, content_hash, summary, concepts,
          token_count, source_uri
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of inputs) {
        const r = insert.run(
          c.collection_id,
          c.source_id,
          c.ord,
          c.heading_path ?? null,
          c.content,
          c.content_hash,
          c.summary ?? null,
          c.concepts && c.concepts.length > 0 ? JSON.stringify(c.concepts) : null,
          c.token_count ?? 0,
          c.source_uri ?? null,
        );
        ids.push(r.lastInsertRowid as number);
      }
    });
    tx();
    return ids;
  }

  getChunk(id: number): DocChunk | null {
    const row = this.db.prepare('SELECT * FROM doc_chunks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapChunk(row) : null;
  }

  getChunksByIds(ids: readonly number[]): DocChunk[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM doc_chunks WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;
    return rows.map(mapChunk);
  }

  /** Returns surrounding chunks (ord ± window) for the same source. */
  getChunkNeighbors(chunkId: number, window: number = 1): DocChunk[] {
    const seed = this.getChunk(chunkId);
    if (!seed) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM doc_chunks
          WHERE source_id = ? AND ord BETWEEN ? AND ?
          ORDER BY ord ASC`,
      )
      .all(seed.source_id, seed.ord - window, seed.ord + window) as Array<Record<string, unknown>>;
    return rows.map(mapChunk);
  }

  listChunksBySource(sourceId: number): DocChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM doc_chunks WHERE source_id = ? ORDER BY ord ASC')
      .all(sourceId) as Array<Record<string, unknown>>;
    return rows.map(mapChunk);
  }

  /**
   * Wipe the embedding state for a source: drops `doc_chunk_vectors`
   * rows AND nulls `embedding_hash` on every chunk so `retryEmbeddings`
   * picks them up as pending. Use when you suspect the remote vector
   * store rejected silently (badge said "✓ embedded" but search returns
   * 0). Local-only operation; remote orphans stay until manual cleanup.
   */
  clearEmbeddingsForSource(sourceId: number): { cleared: number } {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM doc_chunk_vectors WHERE chunk_id IN (
             SELECT id FROM doc_chunks WHERE source_id = ?
           )`,
        )
        .run(sourceId);
      const result = this.db
        .prepare(
          `UPDATE doc_chunks SET embedding_hash = NULL, embedding_provider_id = NULL
            WHERE source_id = ?`,
        )
        .run(sourceId);
      return { cleared: result.changes };
    });
    return tx();
  }

  /**
   * Chunks that still need an embedding. Scoped by `sourceId` (preferred
   * — bounded set) OR `collectionId` (broader) OR neither (all corpus).
   * `sourceId` wins when both are passed.
   *
   * Object-style options so callers don't accidentally pass a sourceId
   * positionally where a collectionId is expected (we had that bug in
   * the use-case's retry path before this refactor).
   */
  listChunksMissingEmbedding(
    opts: { sourceId?: number; collectionId?: number; limit?: number } = {},
  ): DocChunk[] {
    const where: string[] = ['embedding_hash IS NULL'];
    const params: Record<string, unknown> = { limit: opts.limit ?? 500 };
    if (opts.sourceId != null) {
      where.push('source_id = @sourceId');
      params.sourceId = opts.sourceId;
    } else if (opts.collectionId != null) {
      where.push('collection_id = @collectionId');
      params.collectionId = opts.collectionId;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM doc_chunks WHERE ${where.join(' AND ')} ORDER BY id LIMIT @limit`,
      )
      .all(params) as Array<Record<string, unknown>>;
    return rows.map(mapChunk);
  }

  updateChunkEmbedding(chunkId: number, embeddingHash: string, providerId: string): void {
    this.db
      .prepare(
        `UPDATE doc_chunks
            SET embedding_hash = ?, embedding_provider_id = ?
          WHERE id = ?`,
      )
      .run(embeddingHash, providerId, chunkId);
  }

  countChunksByCollection(collectionId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as c FROM doc_chunks WHERE collection_id = ?')
      .get(collectionId) as { c: number };
    return row.c;
  }

  // ─── Vector mapping ──────────────────────────────────────────────

  /**
   * Collect every (vector_id, provider) pair currently mapped to chunks
   * belonging to `sourceId`. MUST be called BEFORE the `DELETE FROM
   * doc_sources` because the FK cascade wipes `doc_chunk_vectors` rows
   * along with the chunks — by the time the delete commits, this lookup
   * returns empty.
   */
  listVectorIdsForSource(sourceId: number): DocVectorRef[] {
    return this.db
      .prepare(
        `SELECT v.vector_id AS vector_id, v.provider AS provider
           FROM doc_chunk_vectors v
           JOIN doc_chunks c ON c.id = v.chunk_id
          WHERE c.source_id = ?`,
      )
      .all(sourceId) as DocVectorRef[];
  }

  /** Same semantics as `listVectorIdsForSource` but across all sources of a collection. */
  listVectorIdsForCollection(collectionId: number): DocVectorRef[] {
    return this.db
      .prepare(
        `SELECT v.vector_id AS vector_id, v.provider AS provider
           FROM doc_chunk_vectors v
           JOIN doc_chunks c ON c.id = v.chunk_id
          WHERE c.collection_id = ?`,
      )
      .all(collectionId) as DocVectorRef[];
  }

  // ─── Vector tombstones (orphan cleanup retry queue) ─────────────

  /**
   * Enqueue (vector_id, provider) pairs that we failed to delete from
   * the remote vector store. `INSERT OR IGNORE` ensures the UNIQUE
   * constraint dedupes repeated failures for the same vector — the
   * sweep just retries the existing row instead of growing the queue.
   *
   * Returns the count of newly inserted rows (i.e. rows that weren't
   * already queued from a previous failure).
   */
  recordTombstones(items: ReadonlyArray<DocVectorRef & { error?: string | null }>): number {
    if (items.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO doc_vector_tombstones (vector_id, provider, last_error)
       VALUES (@vector_id, @provider, @last_error)`,
    );
    let inserted = 0;
    const tx = this.db.transaction((rows: ReadonlyArray<DocVectorRef & { error?: string | null }>) => {
      for (const r of rows) {
        const result = insert.run({
          vector_id: r.vector_id,
          provider: r.provider,
          last_error: r.error ?? null,
        });
        if (result.changes > 0) inserted++;
      }
    });
    tx(items);
    return inserted;
  }

  /** Oldest-first batch of pending tombstones, capped at `limit` (default 500). */
  listPendingTombstones(limit: number = 500): DocVectorTombstoneRow[] {
    return this.db
      .prepare(
        `SELECT id, vector_id, provider, deleted_at, last_retry_at, retry_count, last_error
           FROM doc_vector_tombstones
          ORDER BY deleted_at ASC
          LIMIT @limit`,
      )
      .all({ limit: Math.max(1, limit) }) as DocVectorTombstoneRow[];
  }

  /** Bump retry counter + record latest error on a failed sweep attempt. */
  markTombstoneRetried(id: number, error?: string | null): void {
    this.db
      .prepare(
        `UPDATE doc_vector_tombstones
            SET retry_count   = retry_count + 1,
                last_retry_at = datetime('now'),
                last_error    = @last_error
          WHERE id = @id`,
      )
      .run({ id, last_error: error ?? null });
  }

  /** Drop a tombstone after the remote delete confirmed success. */
  deleteTombstone(id: number): void {
    this.db.prepare(`DELETE FROM doc_vector_tombstones WHERE id = ?`).run(id);
  }

  /** Total pending — for UI badges + boot-sweep logging. */
  /** Total rows in `doc_chunk_vectors`. Used by the diagnose endpoint. */
  countVectorMappings(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM doc_chunk_vectors').get() as { c: number };
    return row.c;
  }

  /**
   * Permanently remove tombstones that have been retried `maxRetries`
   * times without succeeding. Called by `IndexDocumentationUseCase
   * .sweepTombstones` at the start of every sweep — stops the queue
   * from growing forever on IDs the remote will never accept (legacy
   * provider, already-gone vectors, schema drift). After this drop,
   * the dropped IDs remain orphans in the remote store; if that
   * matters in your deployment, run a manual purge by metadata.
   */
  dropExhaustedTombstones(maxRetries: number): { dropped: number } {
    const result = this.db
      .prepare(`DELETE FROM doc_vector_tombstones WHERE retry_count >= ?`)
      .run(maxRetries);
    return { dropped: result.changes };
  }

  countPendingTombstones(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM doc_vector_tombstones`)
      .get() as { c: number };
    return row.c;
  }

  recordChunkVector(chunkId: number, vectorId: string, provider: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO doc_chunk_vectors (chunk_id, vector_id, provider)
         VALUES (?, ?, ?)`,
      )
      .run(chunkId, vectorId, provider);
  }

  getChunkIdForVector(vectorId: string, provider: string): number | null {
    const row = this.db
      .prepare(
        `SELECT chunk_id FROM doc_chunk_vectors WHERE vector_id = ? AND provider = ?`,
      )
      .get(vectorId, provider) as { chunk_id: number } | undefined;
    return row?.chunk_id ?? null;
  }

  /**
   * Rehydrate chunks from a list of (vector_id, provider) pairs. Preserves
   * the input order; missing entries are silently dropped.
   */
  getChunksByVectorIds(vectorIds: readonly string[], provider: string): DocChunk[] {
    if (vectorIds.length === 0) return [];
    const placeholders = vectorIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT c.* FROM doc_chunks c
           JOIN doc_chunk_vectors v ON v.chunk_id = c.id
          WHERE v.vector_id IN (${placeholders}) AND v.provider = ?`,
      )
      .all(...vectorIds, provider) as Array<Record<string, unknown>>;
    const byId = new Map<string, DocChunk>();
    for (const r of rows) byId.set(String(r.id), mapChunk(r));
    // Preserve input order. (Vector_id → chunk_id lookup.)
    const ordered: DocChunk[] = [];
    for (const vid of vectorIds) {
      const chunkId = this.getChunkIdForVector(vid, provider);
      if (chunkId != null) {
        const ch = byId.get(String(chunkId));
        if (ch) ordered.push(ch);
      }
    }
    return ordered;
  }

  // ─── FTS5 search ─────────────────────────────────────────────────

  /**
   * Full-text search over doc_chunks. Returns chunk ids in rank order plus
   * the bm25 rank (lower is better, negate to use as ascending score).
   *
   * `collectionId` scopes results to a single collection when supplied —
   * otherwise searches across all collections.
   */
  searchChunksFts(query: string, opts: { collectionId?: number; limit?: number } = {}): DocFtsHit[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    if (opts.collectionId !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT c.id as chunk_id, fts.rank as rank
             FROM doc_chunks_fts fts
             JOIN doc_chunks c ON c.id = fts.rowid
            WHERE fts.doc_chunks_fts MATCH ? AND c.collection_id = ?
            ORDER BY fts.rank
            LIMIT ?`,
        )
        .all(sanitized, opts.collectionId, limit) as Array<{ chunk_id: number; rank: number }>;
      return rows;
    }
    const rows = this.db
      .prepare(
        `SELECT rowid as chunk_id, rank
           FROM doc_chunks_fts
          WHERE doc_chunks_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
      )
      .all(sanitized, limit) as Array<{ chunk_id: number; rank: number }>;
    return rows;
  }
}

/**
 * Strip characters that confuse the FTS5 query parser. Same posture as
 * the existing `sanitizeFtsQuery` used by the snapshot search path —
 * defensive subset: drop quotes, parens, NEAR/AND/OR operators if the
 * caller passed user-typed natural language. Leaving them produces
 * cryptic FTS errors instead of zero results.
 */
/**
 * Trim + reject all-whitespace / empty. UI sends `''` for "not set", but
 * we want NULL in the DB so `IS NULL` checks elsewhere stay clean.
 */
function normalizeRequiredPath(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeFtsQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Tokenize by whitespace, drop FTS metacharacters, re-join with AND
  // implied (FTS5 default).
  const tokens = trimmed
    .replace(/["()*:.,;]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !/^(AND|OR|NOT|NEAR)$/i.test(t));
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
}
