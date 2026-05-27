import type {
  DocCollection,
  DocCrawlConfig,
  DocSource,
  DocStore,
} from '@mcp/store/doc-store.js';
import { chunkMarkdown } from '../section-chunker.js';
import { DocError } from '../errors.js';
import type { RawPage } from '../types.js';
import {
  DEFAULT_DRY_RUN_TOKEN_COST_USD_PER_1K,
  HARD_MAX_CHUNKS_PER_SOURCE,
  type DocIngestEstimate,
  type IndexFolderInput,
} from './types.js';

export function requireCollection(docStore: DocStore, id: number): DocCollection {
  const c = docStore.getCollection(id);
  if (!c) throw new DocError('not_found', `collection ${id} not found`);
  return c;
}

export interface EnsureSourceInput {
  collection_id: number;
  type: 'pdf' | 'url' | 'folder';
  uri: string;
  title?: string | null;
  crawl?: DocCrawlConfig;
  pdf_size_bytes?: number;
  folder_root_path?: string | null;
  folder?: IndexFolderInput['folder'];
}

/**
 * Find an existing source by `(collection, uri)` or create one. Used so
 * repeated re-indexes on the same URL update the same row.
 *
 * Persists fresh crawl/folder config from THIS request so:
 *   1. `runIngest` reads it back via `defaultCrawlConfig(source)` if the
 *      caller didn't pass `crawl` explicitly,
 *   2. The next "Re-indexar" click (which reads from the source row, not
 *      from a fresh request body) sees the user's latest intent.
 */
export function ensureSource(docStore: DocStore, input: EnsureSourceInput): DocSource {
  const existing = docStore.listSourcesByCollection(input.collection_id).find(
    (s) => s.uri === input.uri,
  );
  if (existing) {
    if (input.crawl) docStore.updateSourceCrawlConfig(existing.id, input.crawl);
    if (input.folder) docStore.updateSourceFolderConfig(existing.id, input.folder);
    return input.crawl || input.folder
      ? (docStore.getSource(existing.id) ?? existing)
      : existing;
  }
  return docStore.createSource(input);
}

/**
 * Compute a chunk + token + cost estimate from pre-fetched raw pages. Used
 * by the dry-run endpoints to surface a budget hint before the real ingest.
 */
export function estimateFromPages(pages: RawPage[], totalPagesFetched?: number): DocIngestEstimate {
  let chunks = 0;
  let tokens = 0;
  for (const page of pages) {
    const sections = chunkMarkdown(page.markdown ?? '', { defaultRootTitle: page.title ?? 'Document' });
    chunks += sections.length;
    tokens += sections.reduce((acc, s) => acc + s.token_count, 0);
  }
  const estimated_cost_usd = (tokens / 1000) * DEFAULT_DRY_RUN_TOKEN_COST_USD_PER_1K;
  const notes: string[] = [];
  if (chunks >= HARD_MAX_CHUNKS_PER_SOURCE) {
    notes.push(`Capped at ${HARD_MAX_CHUNKS_PER_SOURCE} chunks per source.`);
  }
  return {
    pages_to_fetch: totalPagesFetched ?? pages.length,
    pages_likely_accepted: pages.length,
    estimated_chunks: Math.min(chunks, HARD_MAX_CHUNKS_PER_SOURCE),
    estimated_tokens: tokens,
    estimated_cost_usd,
    notes,
  };
}
