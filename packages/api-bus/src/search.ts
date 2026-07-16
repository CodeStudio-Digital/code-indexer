import type { ApiContext } from './common.js';

/**
 * Hybrid search (FTS5 + vector) over the indexed codebase.
 * Source: apps/http-api/server/routes/search.ts.
 */

/** Mirrors `@mcp/shared/types.SearchMode`. */
export type SearchMode = 'fts' | 'vector' | 'hybrid' | 'auto';
/** Mirrors `@mcp/shared/types.SearchType`. */
export type SearchType = 'files' | 'symbols' | 'all';

export interface SearchRequestOptions {
  projectId: number;
  query: string;
  mode?: SearchMode;
  type?: SearchType;
  limit?: number;
  /** Stable latest-wins identity for an interactive search surface. */
  supersessionKey?: string;
}

export interface SearchResult {
  id: number;
  type: SearchType;
  score: number;
  file_path: string;
  line?: number;
  name?: string;
  snippet?: string;
  project?: string;
  project_id?: number;
}

export interface SearchDiagnostics {
  total_time_ms: number;
  fts_time_ms?: number;
  vector_time_ms?: number;
  fts_count?: number;
  vector_count?: number;
  merged_count: number;
  requestedMode?: SearchMode;
  plannedMode?: 'fts' | 'vector' | 'hybrid';
  effectiveMode?: 'fts' | 'vector' | 'hybrid';
  generationUsed?: number;
  embedder?: string;
  reranker?: string;
  fallback?: boolean;
  fallbackReason?: string;
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

// ─── Find/Replace in Files (literal/regex grep over indexed files) ───────
export interface GrepMatch {
  /** 1-based line number. */
  line: number;
  /** Full source line. */
  text: string;
  /** Match span within `text`. */
  start: number;
  end: number;
}
export interface GrepFile {
  path: string;
  matches: GrepMatch[];
}
export interface GrepResult {
  files: GrepFile[];
  total: number;
  fileCount: number;
  /** True when `maxMatches` capped the scan. */
  truncated: boolean;
}
export interface ReplaceResult {
  replaced: number;
  fileCount: number;
}
export interface GrepInput {
  projectId: number;
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Comma-separated globs (e.g. `*.tsx, *.ts`). Empty = all files. */
  mask?: string;
  maxMatches?: number;
}
export interface ReplaceInput extends GrepInput {
  replacement: string;
  /** Restrict the replace to these project-relative paths. */
  files?: string[];
}

export interface SearchApi {
  /** Project-scoped search. */
  project(
    input: SearchRequestOptions,
    ctx: ApiContext,
  ): Promise<{ results: SearchResult[]; diagnostics: SearchDiagnostics }>;

  /** Global search across all projects with one owner-side rerank. */
  global(
    input: Omit<SearchRequestOptions, 'projectId'>,
    ctx: ApiContext,
  ): Promise<SearchResult[]>;

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

  /** Find in Files — literal/regex grep with per-match positions for highlighting. */
  grep(input: GrepInput, ctx: ApiContext): Promise<GrepResult>;

  /** Replace in Files — apply the same matcher and write changed files. */
  replace(input: ReplaceInput, ctx: ApiContext): Promise<ReplaceResult>;
}
