export type DocCollectionStatus = 'idle' | 'indexing' | 'error';

/**
 * Tipo do source. `'pdf'` = upload manual; `'url'` = crawl HTTP;
 * `'folder'` = leitura recursiva de uma pasta no filesystem do servidor.
 */
export type DocSourceType = 'pdf' | 'url' | 'folder';
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
   * include/exclude regex but BEFORE the fetcher runs. Empty/null disables.
   * Common use: pin a manual version so the crawl doesn't wander into siblings.
   */
  required_path?: string | null;
  /**
   * When true, the crawler runs an LLM on the seed page to surface URLs that
   * cheerio missed — typically nav trees built by client-side JS. 1 LLM call
   * per source. Falls back silently to cheerio-only when no `link_extractor`
   * binding is configured.
   */
  llm_extract_links?: boolean;
  /**
   * When true, every page in the crawl is fetched via Chromium/Playwright,
   * bypassing the `EscalatingFetcher` heuristic. Required for docs whose
   * navigation is populated by client-side JS. Cost: ~15-30s/page vs ~100ms.
   */
  force_browser?: boolean;
  /**
   * Hybrid render: use Chromium ONLY for the seed page (depth=0), then fall
   * back to plain HTTP for every discovered leaf. Massive cost win on sites
   * where the sidebar is JS-only but each leaf page is plain HTML.
   *
   * Priority: `force_browser` wins when both flags are on.
   */
  browser_seed_only?: boolean;
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
  crawl_force_browser: boolean;
  crawl_browser_seed_only: boolean;
  pdf_size_bytes: number | null;
  cost_usd: number;
  // Folder config (migration 103). Only meaningful when type === 'folder'.
  folder_root_path: string | null;
  folder_include_glob: string | null;
  folder_exclude_glob: string | null;
  folder_max_files: number | null;
  folder_bypass_relevance_gate: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Configuração do source tipo `'folder'` — espelha o modal "Add Source → Pasta".
 * Todos os campos opcionais têm defaults sensíveis aplicados em `createSource`.
 */
export interface DocFolderConfig {
  /** Glob de inclusão (default: `**\/*.{html,htm,md,markdown,pdf,txt}`). */
  include_glob?: string | null;
  /** Glob de exclusão (default: `**\/{node_modules,.git,dist,build}/**`). */
  exclude_glob?: string | null;
  /** Cap de arquivos lidos (default 5000, server-side hard cap 50000). */
  max_files?: number | null;
  /**
   * Pula o LLM relevance-gate. Default TRUE — docs locais geralmente já vêm
   * curadas. Operador liga via switch "Avançado" pra pastas mistas.
   */
  bypass_relevance_gate?: boolean;
}

export interface DocSourceInput {
  collection_id: number;
  type: DocSourceType;
  uri: string;
  title?: string | null;
  crawl?: DocCrawlConfig;
  /** Caminho ABSOLUTO da raiz da pasta (só relevante quando type='folder'). */
  folder_root_path?: string | null;
  /** Config folder (só relevante quando type='folder'). */
  folder?: DocFolderConfig;
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
 * Truth-source view of a source's persistence + embedding state. Built by
 * JOINing `doc_chunks` and `doc_chunk_vectors` so it doesn't rely on the
 * cached `doc_sources.chunk_count` (which lags during/after a hang).
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

/** (vector_id, provider) pair — used as input to remote delete + row shape for tombstones. */
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

// ─── Auto-discovery suggestions (migration 096) ─────────────────────

export type DocSuggestionStatus = 'pending' | 'approved' | 'dismissed' | 'indexed';

export interface DocSourceSuggestion {
  id: number;
  project_id: number;
  package_manager: string;
  package_name: string;
  package_version: string | null;
  suggested_url: string;
  suggested_title: string | null;
  confidence: number;
  status: DocSuggestionStatus;
  discovered_at: string;
  decided_at: string | null;
  indexed_source_id: number | null;
}
