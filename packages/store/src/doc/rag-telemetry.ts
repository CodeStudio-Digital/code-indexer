import type { Database as DB } from 'better-sqlite3';

export interface EnrichmentCacheValue { summary: string | null; concepts: string[] }

export function getEnrichmentCache(db: DB, contentHash: string, fingerprint: string): EnrichmentCacheValue | null {
  const row = db.prepare(
    `SELECT summary,concepts_json FROM doc_enrichment_cache WHERE content_hash=? AND fingerprint=?`,
  ).get(contentHash, fingerprint) as { summary: string | null; concepts_json: string | null } | undefined;
  if (!row) return null;
  let concepts: string[] = [];
  try { concepts = JSON.parse(row.concepts_json ?? '[]') as string[]; } catch { /* ignore */ }
  return { summary: row.summary, concepts };
}

export function putEnrichmentCache(
  db: DB,
  contentHash: string,
  fingerprint: string,
  value: EnrichmentCacheValue,
): void {
  db.prepare(
    `INSERT INTO doc_enrichment_cache(content_hash,fingerprint,summary,concepts_json)
     VALUES (?,?,?,?) ON CONFLICT(content_hash,fingerprint) DO UPDATE SET
       summary=excluded.summary,concepts_json=excluded.concepts_json,created_at=datetime('now')`,
  ).run(contentHash, fingerprint, value.summary, JSON.stringify(value.concepts));
}

export interface DocSearchEventInput {
  project_id?: number | null;
  query_hash: string;
  scope: string;
  collection_ids?: readonly number[];
  mode: string;
  duration_ms: number;
  fts_hits: number;
  vector_hits: number;
  stale_vector_hits?: number;
  vector_coverage?: number;
  top_relevance?: number | null;
  no_good_match?: boolean;
  result_count: number;
}

export function recordSearchEvent(db: DB, input: DocSearchEventInput): void {
  db.prepare(
    `INSERT INTO doc_search_events(
       project_id,query_hash,scope,collection_ids_json,mode,duration_ms,fts_hits,vector_hits,
       stale_vector_hits,vector_coverage,top_relevance,no_good_match,result_count
     ) VALUES (@project_id,@query_hash,@scope,@collection_ids_json,@mode,@duration_ms,@fts_hits,@vector_hits,
       @stale_vector_hits,@vector_coverage,@top_relevance,@no_good_match,@result_count)`,
  ).run({
    project_id: input.project_id ?? null,
    collection_ids_json: input.collection_ids ? JSON.stringify(input.collection_ids) : null,
    stale_vector_hits: input.stale_vector_hits ?? 0,
    vector_coverage: input.vector_coverage ?? null,
    top_relevance: input.top_relevance ?? null,
    no_good_match: input.no_good_match ? 1 : 0,
    ...input,
  });
}
