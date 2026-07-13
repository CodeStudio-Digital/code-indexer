import type {
  DocChunk,
  DocCollection,
  DocCollectionStatus,
  DocSource,
  DocSourceStatus,
  DocSourceType,
} from './types.js';
import { coerceDocType, type DocType } from './doc-type.js';
import { buildFtsMatch } from '../db/fts-query.js';

export function boolFromInt(n: number | boolean): boolean {
  return typeof n === 'number' ? n !== 0 : !!n;
}

export function mapCollection(row: Record<string, unknown>): DocCollection {
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

export function mapSource(row: Record<string, unknown>): DocSource {
  return {
    id: row.id as number,
    collection_id: row.collection_id as number,
    type: row.type as DocSourceType,
    doc_type: coerceDocType(row.doc_type),
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
    crawl_force_browser: boolFromInt(row.crawl_force_browser as number),
    crawl_browser_seed_only: boolFromInt(row.crawl_browser_seed_only as number),
    pdf_size_bytes: (row.pdf_size_bytes as number | null) ?? null,
    cost_usd: (row.cost_usd as number) ?? 0,
    folder_root_path: (row.folder_root_path as string | null) ?? null,
    folder_include_glob: (row.folder_include_glob as string | null) ?? null,
    folder_exclude_glob: (row.folder_exclude_glob as string | null) ?? null,
    folder_max_files: (row.folder_max_files as number | null) ?? null,
    folder_bypass_relevance_gate: boolFromInt(
      (row.folder_bypass_relevance_gate as number | boolean | undefined) ?? 1,
    ),
    folder_performance_profile: ((row.folder_performance_profile as string | undefined) ?? 'balanced') as DocSource['folder_performance_profile'],
    folder_worker_count: (row.folder_worker_count as number | null) ?? null,
    enrichment_mode: ((row.enrichment_mode as string | undefined) ?? 'selective') as DocSource['enrichment_mode'],
    embedding_fingerprint: (row.embedding_fingerprint as string | null) ?? null,
    last_ingest_run_id: (row.last_ingest_run_id as number | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function mapChunk(row: Record<string, unknown>): DocChunk {
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
    // Chunk doc_type is nullable (older chunks predate typing); keep null so
    // "untyped" stays distinguishable, but coerce any non-null junk to a valid
    // DocType (defense-in-depth, mirrors mapSource).
    doc_type: row.doc_type == null ? null : coerceDocType(row.doc_type),
    anchor: (row.anchor as string | null) ?? null,
    api_symbol: (row.api_symbol as string | null) ?? null,
    api_signature: (row.api_signature as string | null) ?? null,
    stable_key: (row.stable_key as string | null) ?? null,
    item_key: (row.item_key as string | null) ?? null,
    ingest_run_id: (row.ingest_run_id as number | null) ?? null,
    embedding_input_hash: (row.embedding_input_hash as string | null) ?? null,
    embedding_fingerprint: (row.embedding_fingerprint as string | null) ?? null,
    enrichment_fingerprint: (row.enrichment_fingerprint as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

/**
 * Normaliza o input do operador antes de gravar em `crawl_required_path`.
 *
 * Histórico:
 *   v1 (migration 089): single substring. `trim()` + null se vazio.
 *   v2 (PR 13): multi-line. Cada linha é um path independente (OR no crawler).
 *               Reusa a mesma coluna TEXT — backend re-interpreta como
 *               newline-separated.
 *
 * Comportamento:
 *   - null/undefined → null.
 *   - Split por `\r?\n`, trim em cada linha, descarta blanks.
 *   - Re-junta com `\n` (forma canônica no DB).
 *   - Retorna null se nada sobrou (whitespace-only).
 */
export function normalizeRequiredPath(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const lines = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Strip characters that confuse the FTS5 query parser. Defensive subset:
 * drop quotes, parens, NEAR/AND/OR operators when the caller passed
 * user-typed natural language. Leaving them produces cryptic FTS errors
 * instead of zero results.
 */
export function sanitizeFtsQuery(raw: string): string {
  return buildFtsMatch(raw, 'AND');
}
