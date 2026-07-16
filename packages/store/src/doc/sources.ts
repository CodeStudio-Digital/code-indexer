import type { Database as DB } from 'better-sqlite3';
import type {
  DocCrawlConfig,
  DocFolderConfig,
  DocSource,
  DocSourceHealth,
  DocSourceInput,
  DocSourceStatus,
} from './types.js';
import { mapSource, normalizeRequiredPath } from './mappers.js';
import { coerceDocType } from './doc-type.js';
import * as collections from './collections.js';

export function create(db: DB, input: DocSourceInput): DocSource {
  const crawl = input.crawl ?? {};
  const folder = input.folder ?? {};
  // Defense-in-depth: validate type here for a clear error instead of the
  // cryptic "constraint failed" from the CHECK.
  if (input.type !== 'pdf' && input.type !== 'url' && input.type !== 'folder') {
    throw new Error(`createSource: unknown type "${String(input.type)}"`);
  }
  if (input.type === 'folder' && !input.folder_root_path) {
    throw new Error('createSource(folder): folder_root_path is required');
  }
  const stmt = db.prepare(`
    INSERT INTO doc_sources (
      collection_id, type, doc_type, uri, title,
      crawl_enabled, crawl_max_pages, crawl_max_depth, crawl_same_origin,
      crawl_include_pattern, crawl_exclude_pattern, crawl_required_path,
      crawl_llm_extract_links, crawl_force_browser, crawl_browser_seed_only,
      pdf_size_bytes,
      folder_root_path, folder_include_glob, folder_exclude_glob,
      folder_max_files, folder_bypass_relevance_gate, enrichment_mode,
      folder_performance_profile, folder_worker_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.collection_id,
    input.type,
    coerceDocType(input.doc_type),
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
    crawl.force_browser ? 1 : 0,
    crawl.browser_seed_only ? 1 : 0,
    input.pdf_size_bytes ?? null,
    input.folder_root_path ?? null,
    folder.include_glob ?? null,
    folder.exclude_glob ?? null,
    folder.max_files ?? null,
    // Default TRUE — docs locais geralmente já vêm curadas.
    folder.bypass_relevance_gate === false ? 0 : 1,
    input.enrichment_mode ?? 'selective',
    folder.performance_profile ?? 'balanced',
    folder.worker_count ?? null,
  );
  collections.refreshCounts(db, input.collection_id);
  return get(db, result.lastInsertRowid as number)!;
}

export function get(db: DB, id: number): DocSource | null {
  const row = db.prepare('SELECT * FROM doc_sources WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapSource(row) : null;
}

export function listByCollection(db: DB, collectionId: number): DocSource[] {
  const rows = db
    .prepare('SELECT * FROM doc_sources WHERE collection_id = ? ORDER BY created_at DESC')
    .all(collectionId) as Array<Record<string, unknown>>;
  return rows.map(mapSource);
}

export function updateStatus(db: DB, id: number, status: DocSourceStatus, errorMessage?: string | null): void {
  db
    .prepare(
      `UPDATE doc_sources
          SET status = ?, error_message = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(status, errorMessage ?? null, id);
}

export type SourceStatsPatch = Partial<{
  content_hash: string | null;
  title: string | null;
  chunk_count: number;
  page_count: number;
  pages_accepted: number;
  pages_rejected: number;
  cost_usd: number;
  last_indexed_at: string | null;
  embedding_fingerprint: string | null;
  last_ingest_run_id: number | null;
}>;

/**
 * Patch counter columns + optional cost increment. Pass only the fields you
 * want to overwrite. `cost_usd` is set absolutely (caller passes the
 * accumulated total), not added.
 */
export function updateStats(db: DB, id: number, patch: SourceStatsPatch): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE doc_sources SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
}

/** Re-tag a source's documentation type (migration 149). */
export function updateDocType(db: DB, id: number, docType: string): void {
  db.prepare(
    `UPDATE doc_sources SET doc_type = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(coerceDocType(docType), id);
}

export function del(db: DB, id: number): void {
  const src = get(db, id);
  db.prepare('DELETE FROM doc_sources WHERE id = ?').run(id);
  if (src) collections.refreshCounts(db, src.collection_id);
}

/**
 * Overwrite the persisted crawl config of an existing source row. Called by
 * `ensureSource` when the user re-submits the same URL with a different
 * crawl payload. Without this, `ensureSource` returns the old row unchanged.
 * All fields are overwritten — pass the full `DocCrawlConfig` you want.
 */
export function updateCrawlConfig(db: DB, id: number, crawl: DocCrawlConfig): void {
  db
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
              crawl_force_browser      = @force_browser,
              crawl_browser_seed_only  = @browser_seed_only,
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
      force_browser: crawl.force_browser ? 1 : 0,
      browser_seed_only: crawl.browser_seed_only ? 1 : 0,
    });
}

/**
 * Symmetric with `updateCrawlConfig` but for `folder_*` columns (migration
 * 103). Does NOT touch `folder_root_path` — root path is set at create-time
 * and considered immutable.
 */
export function updateFolderConfig(db: DB, id: number, folder: DocFolderConfig): void {
  db
    .prepare(
      `UPDATE doc_sources
          SET folder_include_glob          = @include_glob,
              folder_exclude_glob          = @exclude_glob,
              folder_max_files             = @max_files,
              folder_bypass_relevance_gate = @bypass_relevance_gate,
              folder_performance_profile   = @performance_profile,
              folder_worker_count          = @worker_count,
              updated_at                   = datetime('now')
        WHERE id = @id`,
    )
    .run({
      id,
      include_glob: folder.include_glob ?? null,
      exclude_glob: folder.exclude_glob ?? null,
      max_files: folder.max_files ?? null,
      bypass_relevance_gate: folder.bypass_relevance_gate === false ? 0 : 1,
      performance_profile: folder.performance_profile ?? 'balanced',
      worker_count: folder.worker_count ?? null,
    });
}

export function updateEnrichmentMode(db: DB, id: number, mode: string): void {
  const normalized = mode === 'all' || mode === 'off' ? mode : 'selective';
  db.prepare(`UPDATE doc_sources SET enrichment_mode=?, updated_at=datetime('now') WHERE id=?`)
    .run(normalized, id);
}

/**
 * One-shot health snapshot: status + actual counts of persisted chunks and
 * embedded vectors. `chunks_persisted` reads `doc_chunks` directly; accepted
 * coverage comes from semantic_items in the generation currently receiving
 * writes (building, otherwise active).
 */
export function getHealth(db: DB, sourceId: number): DocSourceHealth | null {
  const row = db
    .prepare(
      `SELECT s.id AS source_id, s.status, s.last_indexed_at, s.embedding_fingerprint,
              (SELECT COUNT(*) FROM doc_chunks WHERE source_id = s.id) AS chunks_persisted,
              (SELECT COUNT(DISTINCT c.id)
                 FROM doc_chunks c
                 JOIN semantic_namespace_generations ng
                   ON ng.namespace = 'docs:c' || c.collection_id
                 JOIN semantic_items si
                   ON si.namespace = ng.namespace
                  AND si.generation_id = COALESCE(
                    ng.building_generation_id, ng.active_generation_id
                  )
                  AND si.item_key = 'doc_chunk:' || c.id
                  AND si.status = 'indexed'
                  AND si.vector_id IS NOT NULL
                WHERE c.source_id = s.id) AS chunks_embedded,
              (SELECT COUNT(*) FROM doc_chunks c
                WHERE c.source_id=s.id AND c.enrichment_fingerprint='pending:llm') AS chunks_unenriched,
              (SELECT id FROM doc_ingest_runs r WHERE r.source_id=s.id AND r.state='running'
                ORDER BY id DESC LIMIT 1) AS active_run_id,
              (SELECT heartbeat_at FROM doc_ingest_runs r WHERE r.source_id=s.id
                ORDER BY id DESC LIMIT 1) AS last_checkpoint_at
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
    lexical_ready: persisted > 0,
    vector_ready: persisted > 0 && persisted === embedded,
    enrichment_ready: persisted > 0 && Number(row.chunks_unenriched ?? 0) === 0,
    embedding_fingerprint: (row.embedding_fingerprint as string | null) ?? null,
    last_checkpoint_at: (row.last_checkpoint_at as string | null) ?? null,
    active_run_id: (row.active_run_id as number | null) ?? null,
  };
}

/**
 * Acquire the source so no second runner can ingest it concurrently. Returns
 * true on success, false if it was already in flight. Sources stuck in
 * `fetching|indexing` for more than `staleAfterMs` (default 5 min) are
 * considered orphaned and re-acquired — makes "Re-indexar" usable after a
 * hang without requiring the user to delete and recreate.
 *
 * NB: all bindings are NAMED — better-sqlite3 rejects mixing `?` positional
 * with `@named` when called with a single object payload.
 */
export function tryAcquire(db: DB, id: number, staleAfterMs: number = 5 * 60 * 1000): boolean {
  const result = db
    .prepare(
      `UPDATE doc_sources
          SET status = 'fetching', error_message = NULL, updated_at = datetime('now')
        WHERE id = @id
          AND (
            status NOT IN ('fetching','indexing')
            OR (
              (julianday('now') - julianday(updated_at)) * 86400 * 1000 > @staleMs
              AND NOT EXISTS (
                SELECT 1 FROM doc_ingest_runs r
                 WHERE r.source_id=doc_sources.id AND r.state='running'
                   AND (julianday('now') - julianday(r.heartbeat_at)) * 86400 * 1000 <= @staleMs
              )
            )
          )`,
    )
    .run({ id, staleMs: staleAfterMs });
  return result.changes > 0;
}

/**
 * Sweep sources left in `fetching|indexing` by a previous server instance
 * (crash, kill, restart) and mark them `error`. Mirrors `recoverStaleAgentRuns`.
 * Run at server boot from `createApp()`.
 */
export function recoverStale(db: DB): { recovered: number } {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE doc_ingest_runs SET state='failed', phase='error',
          error_message=COALESCE(error_message,'Indexação interrompida (servidor reiniciado)'),
          completed_at=datetime('now'), heartbeat_at=datetime('now')
        WHERE state='running'`,
    ).run();
    return db.prepare(
      `UPDATE doc_sources
          SET status = 'error',
              error_message = COALESCE(error_message, 'Indexação interrompida (servidor reiniciado)'),
              updated_at = datetime('now')
        WHERE status IN ('fetching','indexing')`,
    ).run();
  });
  const result = tx();
  return { recovered: result.changes };
}
