/**
 * Shared type contract for the doc-corpus agent tools (`rag_search_docs`,
 * `rag_read_doc`, `rag_doc_outline`) and the host backend that implements them
 * (apps/http-api/server/docs/search-backend.ts) + the worker RPC shims.
 *
 * Extracted from `rag-search-docs.ts` so the tool file stays under the LOC
 * ceiling and so the backend can import the contract without pulling in the
 * tool's runtime singleton. Only the methods/fields the tools actually use are
 * modelled — the code-agent package stays decoupled from `@mcp/services`.
 */

export interface DocSearchBackend {
  search(input: {
    query: string;
    collection?: string;
    limit?: number;
    /** 'project' (default) = prefer project-linked collections; 'all' = global. */
    scope?: 'project' | 'all';
    /** Session's project id — lets the backend resolve linked collections. */
    project_id?: number;
  }): Promise<{
    results: Array<{
      chunk_id: number;
      collection: string;
      source_id: number;
      source_uri: string | null;
      heading_path: string | null;
      /** Heading-level deep-link fragment — cite as `source_uri#anchor`. */
      anchor: string | null;
      /** API symbol (api_reference docs). */
      api_symbol: string | null;
      /** API signature (api_reference docs). */
      api_signature: string | null;
      snippet: string;
      /** Raw fusion score — opaque. Prefer `relevance` when present. */
      score: number;
      /** Calibrated 0-1 relevance from the reranker; null when uncalibrated. */
      relevance: number | null;
      summary: string | null;
      concepts: string[];
    }>;
    diag: {
      fts_hits: number;
      vector_hits: number;
      mode: 'hybrid' | 'fts' | 'vector';
      embedding_available: boolean;
      vector_available: boolean;
      /** Calibrated scoring ran and nothing cleared the relevance bar. */
      no_good_match?: boolean;
      /** Best calibrated relevance seen (even when below the bar). */
      top_relevance?: number | null;
      /** 'project' when filtered to project-linked collections. */
      scope?: 'project' | 'all';
      /** Names of the collections searched when scope === 'project'. */
      scoped_collections?: string[];
    };
  }>;
  /**
   * Full-content read of one chunk + its neighbors — backs `rag_read_doc`.
   * Optional so older backend wirings keep type-checking; the tool emits a
   * clear "not available" error when absent. Null = chunk id not found.
   */
  readChunk?(input: { chunk_id: number; window?: number }): Promise<DocChunkRead | null>;
  /**
   * Whole-section read: every chunk sharing the seed's heading on the same
   * page, reassembled in `ord` order. Backs `rag_read_doc({mode:'section'})`.
   * Null = chunk id not found.
   */
  readSection?(input: { chunk_id: number }): Promise<DocSectionRead | null>;
  /**
   * Navigation: a source's heading TREE (when `source_id` is given) or a
   * collection's SOURCE list (when `collection` is given). Backs
   * `rag_doc_outline`. Null = unknown source/collection.
   */
  outline?(input: { source_id?: number; collection?: string }): Promise<DocOutline | null>;
}

export interface DocChunkNeighborRef {
  chunk_id: number;
  ord: number;
  heading_path: string | null;
  content: string;
  token_count: number;
  /** Page URL this neighbor came from — lets the agent see when it's a different page. */
  source_uri: string | null;
}

export interface DocChunkRead {
  chunk: {
    chunk_id: number;
    collection: string;
    source_id: number;
    source_uri: string | null;
    heading_path: string | null;
    anchor: string | null;
    api_symbol: string | null;
    api_signature: string | null;
    content: string;
    token_count: number;
    summary: string | null;
    concepts: string[];
  };
  /** Neighbors by `ord` within the same source, ascending. */
  prev: DocChunkNeighborRef[];
  next: DocChunkNeighborRef[];
}

/** One reassembled section (all size-split chunks of a heading on a page). */
export interface DocSectionRead {
  source_id: number;
  collection: string;
  source_uri: string | null;
  heading_path: string | null;
  anchor: string | null;
  api_symbol: string | null;
  api_signature: string | null;
  doc_type: string | null;
  chunks: Array<{ chunk_id: number; ord: number; content: string; token_count: number }>;
  total_tokens: number;
}

/** One heading in a source's outline (collapses size-split runs into one entry). */
export interface DocOutlineHeading {
  heading_path: string | null;
  /** First chunk of this heading — feed to rag_read_doc. */
  chunk_id: number;
  ord: number;
  /** How many chunks the section was split into. */
  sections: number;
  /** Total token estimate across those chunks. */
  tokens: number;
  /** Page URL (multi-page crawls list each page's headings). */
  source_uri: string | null;
}

/** One source in a collection's outline. */
export interface DocOutlineSource {
  source_id: number;
  type: string;
  doc_type: string | null;
  title: string | null;
  uri: string;
  chunk_count: number;
}

/** Navigation result: a source list (kind='sources') or a heading tree (kind='headings'). */
export interface DocOutline {
  kind: 'sources' | 'headings';
  collection: string;
  /** kind='headings' only. */
  source_id?: number;
  title?: string | null;
  source_uri?: string | null;
  doc_type?: string | null;
  /** kind='sources' only. */
  sources?: DocOutlineSource[];
  /** kind='headings' only. */
  headings?: DocOutlineHeading[];
}
