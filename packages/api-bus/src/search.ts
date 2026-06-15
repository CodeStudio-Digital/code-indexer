import type { ApiContext } from './common.js';

/**
 * Hybrid search (FTS5 + vector) over the indexed codebase.
 * Source: apps/http-api/server/routes/search.ts.
 */

/** Mirrors `@mcp/shared/types.SearchMode`. */
export type SearchMode = 'fts' | 'vector' | 'hybrid' | 'auto';
/** Mirrors `@mcp/shared/types.SearchType`. */
export type SearchType = 'files' | 'symbols' | 'all';

export interface SearchResult {
  id: number;
  type: SearchType;
  score: number;
  file_path: string;
  line?: number;
  name?: string;
  snippet?: string;
  project?: string;
}

export interface SearchDiagnostics {
  total_time_ms: number;
  fts_time_ms?: number;
  vector_time_ms?: number;
  fts_count?: number;
  vector_count?: number;
  merged_count: number;
}

export interface SymbolHit {
  name: string;
  kind: string;
  file_path: string;
  line: number | null;
  col: number | null;
  signature: string;
  exported: number;
}

export interface TextHit {
  path: string;
}

export interface SearchApi {
  /** Project-scoped search. */
  project(
    input: { projectId: number; query: string; mode?: SearchMode; type?: SearchType; limit?: number },
    ctx: ApiContext,
  ): Promise<{ results: SearchResult[]; diagnostics: SearchDiagnostics }>;

  /** Global search across all projects (concat + sort). */
  global(input: { query: string; limit?: number }, ctx: ApiContext): Promise<SearchResult[]>;

  /**
   * Search Everywhere — Symbols tab. Thin FTS over symbols (prefix per
   * token); no vector/rerank, latency target <20ms.
   */
  symbols(input: { projectId: number; query: string; limit?: number }, ctx: ApiContext): Promise<SymbolHit[]>;

  /**
   * Search Everywhere — Text tab. Word index over raw file contents
   * (file_contents_fts, tokens AND). Returns matching paths ranked by bm25.
   */
  text(input: { projectId: number; query: string; limit?: number }, ctx: ApiContext): Promise<TextHit[]>;
}
