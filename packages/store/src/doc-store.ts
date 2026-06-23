/**
 * DocStore — CRUD over the documentation-corpus tables introduced by
 * migration 086 (`doc_collections`, `doc_sources`, `doc_chunks`,
 * `doc_chunk_vectors`) + the FTS5 helpers needed by `DocHybridSearch`.
 *
 * Tables are GLOBAL (no `project_id`) — collections are shared across all
 * projects. LLM model selection for ingestion/search lives in
 * `pipeline_provider_bindings` (migration 085), not on the collection row.
 *
 * Public API. Bodies live in sub-modules under `./doc/` so this file stays
 * under the 250-LOC ceiling.
 */
import type DatabaseConstructor from 'better-sqlite3';
import * as collections from './doc/collections.js';
import * as sources from './doc/sources.js';
import * as chunks from './doc/chunks.js';
import * as vectorMapping from './doc/vector-mapping.js';
import * as fts from './doc/fts.js';
import * as suggestions from './doc/suggestions.js';
import * as projectLinks from './doc/project-links.js';

type DB = InstanceType<typeof DatabaseConstructor>;

// Documentation type taxonomy (migration 149) — vocabulary + helpers.
export {
  DOC_TYPES,
  DEFAULT_DOC_TYPE,
  DOC_TYPE_LABELS,
  coerceDocType,
  type DocType,
} from './doc/doc-type.js';

// Re-export public types so consumers of `@mcp/store/doc-store.js`
// keep working unchanged.
export type {
  DocCollectionStatus,
  DocSourceType,
  DocSourceStatus,
  DocCollection,
  DocCollectionInput,
  DocCrawlConfig,
  DocSource,
  DocFolderConfig,
  DocSourceInput,
  DocChunkInput,
  DocChunk,
  DocFtsHit,
  DocSourceHealth,
  DocVectorRef,
  DocVectorTombstoneRow,
  DocSuggestionStatus,
  DocSourceSuggestion,
  DocProjectLinkOrigin,
  DocProjectLink,
} from './doc/types.js';

import type {
  DocChunk,
  DocChunkInput,
  DocCollection,
  DocCollectionInput,
  DocCollectionStatus,
  DocCrawlConfig,
  DocFolderConfig,
  DocFtsHit,
  DocProjectLink,
  DocProjectLinkOrigin,
  DocSource,
  DocSourceHealth,
  DocSourceInput,
  DocSourceStatus,
  DocSourceSuggestion,
  DocSuggestionStatus,
  DocVectorRef,
  DocVectorTombstoneRow,
} from './doc/types.js';

export class DocStore {
  constructor(private db: DB) {}

  // ─── Collections ──────────────────────────────────────────────
  createCollection(input: DocCollectionInput): DocCollection { return collections.create(this.db, input); }
  getCollection(id: number): DocCollection | null { return collections.get(this.db, id); }
  getCollectionByName(name: string): DocCollection | null { return collections.getByName(this.db, name); }
  listCollections(): DocCollection[] { return collections.list(this.db); }
  updateCollectionStatus(id: number, status: DocCollectionStatus, message?: string | null): void { collections.updateStatus(this.db, id, status, message); }
  refreshCollectionCounts(id: number): void { collections.refreshCounts(this.db, id); }
  deleteCollection(id: number): void { collections.del(this.db, id); }

  // ─── Sources ──────────────────────────────────────────────────
  createSource(input: DocSourceInput): DocSource { return sources.create(this.db, input); }
  getSource(id: number): DocSource | null { return sources.get(this.db, id); }
  listSourcesByCollection(collectionId: number): DocSource[] { return sources.listByCollection(this.db, collectionId); }
  updateSourceStatus(id: number, status: DocSourceStatus, errorMessage?: string | null): void { sources.updateStatus(this.db, id, status, errorMessage); }
  updateSourceStats(id: number, patch: sources.SourceStatsPatch): void { sources.updateStats(this.db, id, patch); }
  deleteSource(id: number): void { sources.del(this.db, id); }
  updateSourceCrawlConfig(id: number, crawl: DocCrawlConfig): void { sources.updateCrawlConfig(this.db, id, crawl); }
  updateSourceDocType(id: number, docType: string): void { sources.updateDocType(this.db, id, docType); }
  updateSourceFolderConfig(id: number, folder: DocFolderConfig): void { sources.updateFolderConfig(this.db, id, folder); }
  getSourceHealth(sourceId: number): DocSourceHealth | null { return sources.getHealth(this.db, sourceId); }
  tryAcquireSource(id: number, staleAfterMs: number = 5 * 60 * 1000): boolean { return sources.tryAcquire(this.db, id, staleAfterMs); }
  recoverStaleSources(): { recovered: number } { return sources.recoverStale(this.db); }

  // ─── Chunks ───────────────────────────────────────────────────
  insertChunks(inputs: DocChunkInput[]): number[] { return chunks.insert(this.db, inputs); }
  replaceChunksForSource(sourceId: number, inputs: DocChunkInput[]): number[] { return chunks.replaceForSource(this.db, sourceId, inputs); }
  getChunk(id: number): DocChunk | null { return chunks.get(this.db, id); }
  getChunksByIds(ids: readonly number[]): DocChunk[] { return chunks.getByIds(this.db, ids); }
  getChunkNeighbors(chunkId: number, window: number = 1): DocChunk[] { return chunks.getNeighbors(this.db, chunkId, window); }
  listChunksBySource(sourceId: number): DocChunk[] { return chunks.listBySource(this.db, sourceId); }
  listChunksBySourceHeading(sourceId: number, headingPath: string | null, sourceUri: string | null): DocChunk[] { return chunks.listBySourceHeading(this.db, sourceId, headingPath, sourceUri); }
  clearEmbeddingsForSource(sourceId: number): { cleared: number } { return chunks.clearEmbeddingsForSource(this.db, sourceId); }
  listChunksMissingEmbedding(opts: { sourceId?: number; collectionId?: number; limit?: number } = {}): DocChunk[] { return chunks.listMissingEmbedding(this.db, opts); }
  updateChunkEmbedding(chunkId: number, embeddingHash: string, providerId: string): void { chunks.updateEmbedding(this.db, chunkId, embeddingHash, providerId); }
  countChunksByCollection(collectionId: number): number { return chunks.countByCollection(this.db, collectionId); }

  // ─── Vector mapping ───────────────────────────────────────────
  listVectorIdsForSource(sourceId: number): DocVectorRef[] { return vectorMapping.listForSource(this.db, sourceId); }
  listVectorIdsForCollection(collectionId: number): DocVectorRef[] { return vectorMapping.listForCollection(this.db, collectionId); }
  recordChunkVector(chunkId: number, vectorId: string, provider: string): void { vectorMapping.record(this.db, chunkId, vectorId, provider); }
  getChunkIdForVector(vectorId: string, provider: string): number | null { return vectorMapping.getChunkIdForVector(this.db, vectorId, provider); }
  getChunksByVectorIds(vectorIds: readonly string[], provider: string): DocChunk[] { return vectorMapping.getChunksByVectorIds(this.db, vectorIds, provider); }
  countVectorMappings(): number { return vectorMapping.countMappings(this.db); }

  // ─── Vector tombstones (retry queue) ──────────────────────────
  recordTombstones(items: ReadonlyArray<DocVectorRef & { error?: string | null }>): number { return vectorMapping.recordTombstones(this.db, items); }
  listPendingTombstones(limit: number = 500): DocVectorTombstoneRow[] { return vectorMapping.listPendingTombstones(this.db, limit); }
  markTombstoneRetried(id: number, error?: string | null): void { vectorMapping.markTombstoneRetried(this.db, id, error); }
  deleteTombstone(id: number): void { vectorMapping.deleteTombstone(this.db, id); }
  dropExhaustedTombstones(maxRetries: number): { dropped: number } { return vectorMapping.dropExhaustedTombstones(this.db, maxRetries); }
  countPendingTombstones(): number { return vectorMapping.countPendingTombstones(this.db); }

  // ─── FTS5 search ──────────────────────────────────────────────
  searchChunksFts(query: string, opts: { collectionId?: number; collectionIds?: readonly number[]; limit?: number } = {}): DocFtsHit[] { return fts.searchChunks(this.db, query, opts); }

  // ─── Project ↔ collection links (migration 134) ───────────────
  linkProjectCollection(projectId: number, collectionId: number, origin: DocProjectLinkOrigin = 'manual'): boolean { return projectLinks.link(this.db, projectId, collectionId, origin); }
  unlinkProjectCollection(projectId: number, collectionId: number): boolean { return projectLinks.unlink(this.db, projectId, collectionId); }
  listCollectionsForProject(projectId: number): DocCollection[] { return projectLinks.listCollectionsForProject(this.db, projectId); }
  listProjectsForCollection(collectionId: number): DocProjectLink[] { return projectLinks.listProjectsForCollection(this.db, collectionId); }

  // ─── Auto-discovery suggestions (migration 096) ───────────────
  upsertSuggestion(input: suggestions.UpsertSuggestionInput): boolean { return suggestions.upsert(this.db, input); }
  listSuggestions(opts: { projectId: number; status?: DocSuggestionStatus }): DocSourceSuggestion[] { return suggestions.list(this.db, opts); }
  getSuggestion(id: number): DocSourceSuggestion | null { return suggestions.get(this.db, id); }
  setSuggestionStatus(id: number, status: DocSuggestionStatus, indexedSourceId?: number | null): void { suggestions.setStatus(this.db, id, status, indexedSourceId); }
  deleteSuggestion(id: number): boolean { return suggestions.del(this.db, id); }
}
