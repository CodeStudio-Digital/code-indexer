import type { ApiContext, AsyncStream } from './common.js';

/**
 * Documentação (RAG) — global doc corpus, collections, sources (URL/PDF/folder),
 * ingestion, search.
 *
 * Source: apps/http-api/server/routes/docs/index.ts and
 *         apps/http-api/server/routes/docs-agent/index.ts.
 *
 * Tier gate: `requireTier('pro')` on mutations + search (Freemium plan).
 *
 * Many fields are loose — see @mcp/services/services/docs for canonical types.
 */

export interface DocCollection {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
}

export type DocSourceType = 'url' | 'pdf' | 'folder';

export interface DocSource {
  id: number;
  collection_id: number;
  type: DocSourceType;
  uri: string;
  title: string | null;
  status: 'pending' | 'fetching' | 'indexing' | 'done' | 'error';
  /** Folder-source fields (migration 103). */
  folder_root_path?: string | null;
  folder_include_glob?: string | null;
  folder_exclude_glob?: string | null;
  /** URL-crawl fields. */
  crawl_enabled?: boolean;
  crawl_max_pages?: number;
  crawl_max_depth?: number;
}

export interface CrawlConfig {
  enabled?: boolean;
  max_pages?: number;
  max_depth?: number;
  same_origin?: boolean;
  include_pattern?: string | null;
  exclude_pattern?: string | null;
  required_path?: string | null;
  llm_extract_links?: boolean;
  force_browser?: boolean;
  browser_seed_only?: boolean;
}

export interface FolderConfig {
  include_glob?: string | null;
  exclude_glob?: string | null;
  max_files?: number | null;
  bypass_relevance_gate?: boolean;
}

export interface DocIngestProgress {
  source_id: number;
  phase: 'fetching' | 'parsing' | 'chunking' | 'embedding' | 'writing';
  total: number;
  done: number;
  message?: string;
}

export interface DocIngestResult {
  source_id: number;
  chunks_indexed: number;
  pages_fetched: number;
  pages_accepted: number;
  pages_rejected: number;
  pages_via_browser: number;
  cost_usd: number;
  elapsed_ms: number;
}

export type DocIngestEvent =
  | { event: 'open'; data: { ok: true; ts: number } }
  | { event: 'start'; data: DocIngestProgress }
  | { event: 'progress'; data: DocIngestProgress }
  | { event: 'done'; data: DocIngestResult }
  | { event: 'error'; data: { message: string } };

export interface DocSearchHit {
  chunk_id: number;
  source_id: number;
  source_uri: string;
  heading_path: string[];
  snippet: string;
  score: number;
  concepts?: string[];
}

export interface DocsApi {
  collections: {
    list(input: void, ctx: ApiContext): Promise<DocCollection[]>;
    create(input: { name: string; description?: string }, ctx: ApiContext): Promise<DocCollection>;
    get(input: { id: number }, ctx: ApiContext): Promise<DocCollection>;
    delete(input: { id: number }, ctx: ApiContext): Promise<{ ok: true }>;
  };

  sources: {
    list(input: { collectionId: number }, ctx: ApiContext): Promise<DocSource[]>;
    get(input: { srcId: number }, ctx: ApiContext): Promise<DocSource>;
    delete(input: { srcId: number }, ctx: ApiContext): Promise<{ ok: true }>;

    /** Ingest a URL (defer_indexing: only create the row). */
    createUrl(
      input: { collectionId: number; url: string; title?: string; crawl?: CrawlConfig; defer_indexing?: boolean },
      ctx: ApiContext,
    ): Promise<DocSource | DocIngestResult>;

    /** Streaming URL ingestion. */
    createUrlStream(
      input: { collectionId: number; url: string; title?: string; crawl?: CrawlConfig },
      ctx: ApiContext,
    ): AsyncStream<DocIngestEvent>;

    /** PDF upload (always streaming because large). */
    createPdfStream(
      input: { collectionId: number; fileName: string; bytes: Uint8Array; title?: string },
      ctx: ApiContext,
    ): AsyncStream<DocIngestEvent>;

    /** Folder source (migration 103) — defer or stream. */
    createFolder(
      input: { collectionId: number; path: string; title?: string; folder?: FolderConfig; defer_indexing?: boolean },
      ctx: ApiContext,
    ): Promise<DocSource | DocIngestResult>;

    createFolderStream(
      input: { collectionId: number; path: string; title?: string; folder?: FolderConfig },
      ctx: ApiContext,
    ): AsyncStream<DocIngestEvent>;

    reindexStream(input: { srcId: number }, ctx: ApiContext): AsyncStream<DocIngestEvent>;

    /** Pre-flight estimates (no actual ingestion). */
    dryRunUrl(input: { url: string; crawl?: CrawlConfig }, ctx: ApiContext): Promise<unknown>;
    dryRunPdf(input: { fileName: string; bytes: Uint8Array }, ctx: ApiContext): Promise<unknown>;

    /** Live progress snapshot for the SourceList row's mini-bar. */
    progress(input: { srcId: number }, ctx: ApiContext): Promise<{ active: boolean; status: string; snapshot: unknown }>;
    health(input: { srcId: number }, ctx: ApiContext): Promise<unknown>;

    /** Per-source / per-collection embedding retry. */
    retryEmbeddingsStream(input: { srcId?: number; collectionId?: number; force?: boolean }, ctx: ApiContext): AsyncStream<DocIngestEvent>;
  };

  search(
    input: { query: string; collection?: string; limit?: number; mode?: 'hybrid' | 'fts' | 'vector' },
    ctx: ApiContext,
  ): Promise<{ hits: DocSearchHit[] }>;

  vectors: {
    pendingCount(input: void, ctx: ApiContext): Promise<{ pending: number }>;
    sweep(input: void, ctx: ApiContext): Promise<{ drained: number; still_pending: number }>;
    diagnose(input: { query?: string; collection?: string }, ctx: ApiContext): Promise<unknown>;
  };

  /** docs-agent (multi-step deep research) — wraps DocsResearchBridge. */
  research: {
    start(input: { query: string; collection?: string }, ctx: ApiContext): Promise<{ sessionId: number }>;
    stream(input: { sessionId: number }, ctx: ApiContext): AsyncStream<{ event: string; data: unknown }>;
    get(input: { sessionId: number }, ctx: ApiContext): Promise<unknown>;
  };
}
